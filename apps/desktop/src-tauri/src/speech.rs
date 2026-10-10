use serde::{Deserialize, Serialize};
use std::sync::{mpsc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tts::Tts;

#[derive(Default)]
pub struct SpeechState {
    engine: Option<Tts>,
    active: Option<Active>,
}
struct Active {
    id: String,
    native_id: String,
}
pub type SpeechOwner = Mutex<SpeechState>;
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Voice {
    #[serde(rename = "voiceURI")]
    voice_uri: String,
    name: String,
    lang: String,
    local_service: bool,
    default: bool,
}
#[derive(Serialize)]
pub struct Voices {
    voices: Vec<Voice>,
}
#[derive(Clone, Serialize)]
struct Event {
    id: String,
    #[serde(rename = "type")]
    kind: &'static str,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    id: String,
    text: String,
    #[serde(rename = "voiceURI")]
    voice_uri: Option<String>,
    lang: Option<String>,
    rate: f32,
}
fn valid(request: &Request) -> bool {
    !request.id.is_empty()
        && request.id.len() <= 128
        && !request.text.trim().is_empty()
        && request.text.encode_utf16().count() <= 4096
        && request.rate.is_finite()
        && (0.5..=2.0).contains(&request.rate)
        && request.voice_uri.as_ref().is_none_or(|v| v.len() <= 1024)
        && request.lang.as_ref().is_none_or(|v| v.len() <= 100)
}
fn dispatch(app: &AppHandle, native_id: String, kind: &'static str) {
    let handle = app.clone();
    // Called only by our callback worker, so run_on_main_thread always queues a later turn.
    // This avoids reentrant deadlock when an engine begins synchronously inside speak().
    let _ = app.run_on_main_thread(move || {
        let owner = handle.state::<SpeechOwner>();
        let event = owner.lock().ok().and_then(|mut state| {
            let active = state.active.as_ref()?;
            if active.native_id != native_id {
                return None;
            }
            let event = Event {
                id: active.id.clone(),
                kind,
            };
            if kind == "end" || kind == "cancel" {
                state.active = None;
            }
            Some(event)
        });
        if let Some(event) = event {
            let _ = handle.emit_to("main", "avid:desktop-speech", event);
        }
    });
}
pub fn initialize(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    let engine = Tts::new(tts::Backends::AvFoundation);
    #[cfg(not(target_os = "macos"))]
    let engine = Tts::default();
    let engine = engine.ok().and_then(|engine| {
        let features = engine.supported_features();
        if !features.utterance_callbacks || !features.voice || !features.stop || !features.rate {
            return None;
        }
        let (sender, receiver) = mpsc::channel::<(String, &'static str)>();
        let handle = app.clone();
        std::thread::spawn(move || {
            for (id, kind) in receiver {
                dispatch(&handle, id, kind);
            }
        });
        let begin = sender.clone();
        let end = sender.clone();
        engine
            .on_utterance_begin(Some(Box::new(move |id| {
                let _ = begin.send((format!("{id:?}"), "start"));
            })))
            .ok()?;
        engine
            .on_utterance_end(Some(Box::new(move |id| {
                let _ = end.send((format!("{id:?}"), "end"));
            })))
            .ok()?;
        engine
            .on_utterance_stop(Some(Box::new(move |id| {
                let _ = sender.send((format!("{id:?}"), "cancel"));
            })))
            .ok()?;
        Some(engine)
    });
    app.manage(Mutex::new(SpeechState {
        engine,
        active: None,
    }));
}
pub fn available(app: &AppHandle) -> bool {
    app.state::<SpeechOwner>()
        .lock()
        .map(|s| s.engine.is_some())
        .unwrap_or(false)
}
#[tauri::command]
pub fn desktop_speech_voices(
    window: WebviewWindow,
    state: State<SpeechOwner>,
) -> Result<Voices, String> {
    crate::surfaces::main_window(&window)?;
    let state = state.lock().map_err(|_| "Speech state unavailable.")?;
    let Some(engine) = &state.engine else {
        return Ok(Voices { voices: vec![] });
    };
    let current = engine.voice().ok().flatten().map(|v| v.id());
    let voices = engine
        .voices()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|voice| Voice {
            default: current.as_ref().is_some_and(|id| *id == voice.id()),
            voice_uri: voice.id(),
            name: voice.name(),
            lang: voice.language().to_string(),
            local_service: true,
        })
        .collect();
    Ok(Voices { voices })
}
#[tauri::command]
pub fn desktop_speech_speak(
    window: WebviewWindow,
    state: State<SpeechOwner>,
    request: Request,
) -> Result<(), String> {
    crate::surfaces::main_window(&window)?;
    if !valid(&request) {
        return Err("Invalid speech request or text exceeds 4096 UTF-16 units.".into());
    }
    let mut state = state.lock().map_err(|_| "Speech state unavailable.")?;
    state.active = None;
    let engine = state
        .engine
        .as_mut()
        .ok_or("No installed native speech backend is available.")?;
    engine.stop().map_err(|e| e.to_string())?;
    let voices = engine.voices().map_err(|e| e.to_string())?;
    if let Some(id) = &request.voice_uri {
        let voice = voices
            .iter()
            .find(|v| v.id() == *id)
            .ok_or("The selected voice is no longer installed.")?;
        engine.set_voice(voice).map_err(|e| e.to_string())?;
    } else if let Some(lang) = &request.lang {
        if let Some(voice) = voices
            .iter()
            .find(|v| v.language().to_string().eq_ignore_ascii_case(lang))
        {
            engine.set_voice(voice).map_err(|e| e.to_string())?;
        }
    }
    // Engine scales differ: map user speed around the engine's normal rate and clamp its range.
    let normal = engine.normal_rate();
    let rate = if normal == 0.0 {
        if request.rate >= 1.0 {
            (request.rate - 1.0) * engine.max_rate()
        } else {
            (1.0 - request.rate) * 2.0 * engine.min_rate()
        }
    } else {
        normal * request.rate
    };
    engine
        .set_rate(rate.clamp(engine.min_rate(), engine.max_rate()))
        .map_err(|e| e.to_string())?;
    let native = engine
        .speak(request.text, false)
        .map_err(|e| e.to_string())?
        .ok_or("This engine did not provide a trackable utterance.")?;
    state.active = Some(Active {
        id: request.id,
        native_id: format!("{native:?}"),
    });
    Ok(())
}
#[tauri::command]
pub fn desktop_speech_cancel(
    window: WebviewWindow,
    state: State<SpeechOwner>,
    id: Option<String>,
) -> Result<(), String> {
    crate::surfaces::main_window(&window)?;
    let mut state = state.lock().map_err(|_| "Speech state unavailable.")?;
    if let Some(id) = id {
        if state.active.as_ref().is_none_or(|active| active.id != id) {
            return Ok(());
        }
    }
    state.active = None;
    if let Some(engine) = &mut state.engine {
        engine.stop().map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Request {
        Request {
            id: "id".into(),
            text: "A paragraph".into(),
            voice_uri: None,
            lang: None,
            rate: 1.0,
        }
    }
    #[test]
    fn checks_utf16_limit_without_truncating_surrogates() {
        let mut value = request();
        value.text = "😀".repeat(2048);
        assert!(valid(&value));
        value.text.push('a');
        assert!(!valid(&value));
    }
    #[test]
    fn rejects_invalid_rate_and_empty_text() {
        let mut value = request();
        value.rate = f32::NAN;
        assert!(!valid(&value));
        value.rate = 1.0;
        value.text.clear();
        assert!(!valid(&value));
    }
}
