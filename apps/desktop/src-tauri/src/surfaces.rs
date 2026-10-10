use serde::{Deserialize, Serialize};
use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition, PlatformConfig,
    SeekDirection,
};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::PathBuf,
    sync::{mpsc, Mutex},
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, State, WebviewWindow,
};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Recent {
    pub book_id: String,
    pub file_id: String,
    pub title: String,
    pub author: String,
    pub kind: String,
    pub progress: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Media {
    pub book_id: String,
    pub file_id: String,
    pub title: String,
    pub author: String,
    pub chapter: Option<String>,
    pub position: f64,
    pub duration: f64,
    pub playing: bool,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub account_scope: Option<String>,
    pub recents: Vec<Recent>,
    pub media: Option<Media>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    account_scope: String,
    book_id: Option<String>,
    file_id: Option<String>,
    kind: Option<String>,
    action: &'static str,
    position: Option<f64>,
}
#[derive(Default)]
pub struct Surfaces {
    snapshot: Snapshot,
    controls: Option<MediaControls>,
    tray: bool,
    recent_ids: HashMap<String, Recent>,
    menu_generation: u64,
}
pub type SurfaceState = Mutex<Surfaces>;
fn text(value: &str, limit: usize, empty: bool) -> bool {
    (empty || !value.trim().is_empty()) && value.len() <= limit && !value.contains('\0')
}
fn identity(book: &str, file: &str) -> bool {
    text(book, 4096, false) && text(file, 4096, false)
}
fn validate(snapshot: &Snapshot) -> Result<(), String> {
    if let Some(scope) = &snapshot.account_scope {
        if scope.len() > 8192 {
            return Err("Invalid account scope.".into());
        }
        let values: Vec<String> =
            serde_json::from_str(scope).map_err(|_| "Invalid account scope.")?;
        if values.len() != 2 || values.iter().any(|v| v.is_empty()) {
            return Err("Invalid account scope.".into());
        }
    } else if !snapshot.recents.is_empty() || snapshot.media.is_some() {
        return Err("An active account is required.".into());
    }
    if snapshot.recents.len() > 20 {
        return Err("Publish at most 20 recent books.".into());
    }
    for item in &snapshot.recents {
        if !identity(&item.book_id, &item.file_id)
            || !text(&item.title, 1024, false)
            || !text(&item.author, 1024, true)
            || !["epub", "pdf", "comic", "audio"].contains(&item.kind.as_str())
            || !item.progress.is_finite()
            || !(0.0..=1.0).contains(&item.progress)
        {
            return Err("Invalid recent book.".into());
        }
    }
    if let Some(media) = &snapshot.media {
        if !identity(&media.book_id, &media.file_id)
            || !text(&media.title, 1024, false)
            || !text(&media.author, 1024, true)
            || media.chapter.as_ref().is_some_and(|v| !text(v, 1024, true))
            || !media.position.is_finite()
            || !media.duration.is_finite()
            || !(0.0..=1e9).contains(&media.position)
            || !(0.0..=1e9).contains(&media.duration)
        {
            return Err("Invalid media state.".into());
        }
    }
    Ok(())
}
pub fn main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Only Avid's main application can use this command.".into())
    }
}
fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
fn recent_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join("recents.json"))
        .map_err(|e| e.to_string())
}
fn persist(app: &AppHandle, snapshot: &Snapshot) -> Result<(), String> {
    let path = recent_path(app)?;
    if snapshot.account_scope.is_none() {
        if path.exists() {
            fs::remove_file(path).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let parent = path.parent().ok_or("Missing data directory.")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = path.with_extension("tmp");
    let mut file = fs::File::create(&temporary).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    // Only permitted metadata is saved. Playback source URLs, tokens and book text are absent.
    let saved = Snapshot {
        media: None,
        ..snapshot.clone()
    };
    let bytes = serde_json::to_vec(&saved).map_err(|e| e.to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    fs::rename(temporary, path).map_err(|e| e.to_string())
}
fn recovered_recents(app: &AppHandle, scope: &str) -> Vec<Recent> {
    let recovered = (|| -> Option<Snapshot> {
        let path = recent_path(app).ok()?;
        if fs::metadata(&path).ok()?.len() > 262144 {
            return None;
        }
        let value: Snapshot = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
        validate(&value).ok()?;
        (value.account_scope.as_deref() == Some(scope)).then_some(value)
    })();
    recovered.map(|value| value.recents).unwrap_or_default()
}
fn media_action(app: &AppHandle, event: MediaControlEvent) {
    if matches!(event, MediaControlEvent::Raise) {
        show(app);
        return;
    }
    if matches!(event, MediaControlEvent::Quit) {
        app.exit(0);
        return;
    }
    let state = app.state::<SurfaceState>();
    let state = match state.lock() {
        Ok(v) => v,
        Err(_) => return,
    };
    let (Some(scope), Some(media)) = (&state.snapshot.account_scope, &state.snapshot.media) else {
        return;
    };
    let (action, position) = match event {
        MediaControlEvent::Play => ("play", None),
        MediaControlEvent::Pause => ("pause", None),
        MediaControlEvent::Toggle => ("toggle", None),
        MediaControlEvent::Stop => ("stop", None),
        MediaControlEvent::Next | MediaControlEvent::Seek(SeekDirection::Forward) => ("next", None),
        MediaControlEvent::Previous | MediaControlEvent::Seek(SeekDirection::Backward) => {
            ("previous", None)
        }
        MediaControlEvent::SetPosition(MediaPosition(value)) => {
            ("seek", Some(value.as_secs_f64().min(media.duration)))
        }
        MediaControlEvent::SeekBy(direction, value) => {
            let delta = value.as_secs_f64()
                * if direction == SeekDirection::Forward {
                    1.0
                } else {
                    -1.0
                };
            (
                "seek",
                Some((media.position + delta).max(0.0).min(media.duration)),
            )
        }
        // External controllers cannot cause arbitrary URI navigation or native file access.
        _ => return,
    };
    let value = Action {
        account_scope: scope.clone(),
        book_id: Some(media.book_id.clone()),
        file_id: Some(media.file_id.clone()),
        kind: Some("audio".into()),
        action,
        position,
    };
    let _ = app.emit_to("main", "avid:desktop-action", value);
}
fn refresh_menu(app: &AppHandle, state: &mut Surfaces) -> Result<(), String> {
    if !state.tray {
        return Ok(());
    }
    let menu = Menu::new(app).map_err(|e| e.to_string())?;
    menu.append(
        &MenuItem::with_id(app, "avid.show", "Open Avid", true, None::<&str>)
            .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    menu.append(
        &MenuItem::with_id(
            app,
            "avid.toggle",
            if state.snapshot.media.as_ref().is_some_and(|m| m.playing) {
                "Pause"
            } else {
                "Play"
            },
            state.snapshot.media.is_some(),
            None::<&str>,
        )
        .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    menu.append(&PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    state.menu_generation = state.menu_generation.wrapping_add(1);
    state.recent_ids.clear();
    for (index, recent) in state.snapshot.recents.iter().enumerate() {
        let id = format!("avid.recent.{}.{}", state.menu_generation, index);
        let label: String = recent.title.chars().take(70).collect();
        menu.append(
            &MenuItem::with_id(app, &id, label, true, None::<&str>).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        state.recent_ids.insert(id, recent.clone());
    }
    menu.append(&PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    menu.append(
        &MenuItem::with_id(app, "avid.quit", "Quit Avid", true, None::<&str>)
            .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    app.tray_by_id("avid")
        .ok_or("The tray is unavailable.")?
        .set_menu(Some(menu))
        .map_err(|e| e.to_string())
}
pub fn initialize(app: &AppHandle) {
    let mut state = Surfaces::default();
    #[cfg(target_os = "windows")]
    let hwnd = app
        .get_webview_window("main")
        .and_then(|window| window.hwnd().ok())
        .map(|value| value.0 as *mut std::ffi::c_void);
    #[cfg(not(target_os = "windows"))]
    let hwnd = None;
    if let Ok(mut controls) = MediaControls::new(PlatformConfig {
        dbus_name: "app.avid.reader",
        display_name: "Avid",
        hwnd,
    }) {
        let handle = app.clone();
        let (sender, receiver) = mpsc::channel::<MediaControlEvent>();
        std::thread::spawn(move || {
            for event in receiver {
                let handler = handle.clone();
                let _ = handle.run_on_main_thread(move || media_action(&handler, event));
            }
        });
        if controls
            .attach(move |event| {
                let _ = sender.send(event);
            })
            .is_ok()
        {
            state.controls = Some(controls);
        }
    }
    let mut tray = TrayIconBuilder::with_id("avid")
        .tooltip("Avid")
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            match id {
                "avid.show" => show(app),
                "avid.quit" => app.exit(0),
                "avid.toggle" => media_action(app, MediaControlEvent::Toggle),
                _ => {
                    let state = app.state::<SurfaceState>();
                    let action = state.lock().ok().and_then(|state| {
                        let scope = state.snapshot.account_scope.as_ref()?;
                        let recent = state.recent_ids.get(id)?;
                        Some(Action {
                            account_scope: scope.clone(),
                            book_id: Some(recent.book_id.clone()),
                            file_id: Some(recent.file_id.clone()),
                            kind: Some(recent.kind.clone()),
                            action: "open",
                            position: None,
                        })
                    });
                    if let Some(action) = action {
                        show(app);
                        let _ = app.emit_to("main", "avid:desktop-action", action);
                    }
                }
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    state.tray = tray.build(app).is_ok();
    let _ = refresh_menu(app, &mut state);
    app.manage(Mutex::new(state));
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    media_controls_available: bool,
    tray_available: bool,
    speech_available: bool,
    word_boundaries_available: bool,
}
#[tauri::command]
pub fn desktop_capabilities(
    window: WebviewWindow,
    app: AppHandle,
    state: State<SurfaceState>,
) -> Result<Capabilities, String> {
    main_window(&window)?;
    let state = state.lock().map_err(|_| "Desktop state unavailable.")?;
    Ok(Capabilities {
        media_controls_available: state.controls.is_some(),
        tray_available: state.tray,
        speech_available: crate::speech::available(&app),
        word_boundaries_available: false,
    })
}
#[tauri::command]
pub fn desktop_publish(
    window: WebviewWindow,
    app: AppHandle,
    state: State<SurfaceState>,
    mut snapshot: Snapshot,
) -> Result<(), String> {
    main_window(&window)?;
    validate(&snapshot)?;
    let mut state = state.lock().map_err(|_| "Desktop state unavailable.")?;
    if state.snapshot.account_scope.is_none() && snapshot.recents.is_empty() {
        if let Some(scope) = &snapshot.account_scope {
            snapshot.recents = recovered_recents(&app, scope);
        }
    }
    let changed_recents = state.snapshot.account_scope != snapshot.account_scope
        || state.snapshot.recents != snapshot.recents;
    let menu_changed = changed_recents
        || state.snapshot.media.as_ref().map(|m| m.playing)
            != snapshot.media.as_ref().map(|m| m.playing);
    // Revoke old account authority before any fallible disk/OS operation. An old visible menu item
    // cannot authorize navigation after logout even when persistence or tray refresh fails.
    if changed_recents {
        state.recent_ids.clear();
    }
    state.snapshot = snapshot.clone();
    let mut failure = None;
    if changed_recents {
        if let Err(error) = persist(&app, &snapshot) {
            failure = Some(error);
        }
    }
    if let Some(controls) = &mut state.controls {
        let updated = if let Some(media) = &snapshot.media {
            controls
                .set_metadata(MediaMetadata {
                    title: Some(&media.title),
                    artist: Some(&media.author),
                    album: media.chapter.as_deref().or(Some("Avid")),
                    duration: Some(Duration::from_secs_f64(media.duration)),
                    ..Default::default()
                })
                .and_then(|_| {
                    let progress = Some(MediaPosition(Duration::from_secs_f64(media.position)));
                    controls.set_playback(if media.playing {
                        MediaPlayback::Playing { progress }
                    } else {
                        MediaPlayback::Paused { progress }
                    })
                })
        } else {
            controls
                .set_playback(MediaPlayback::Stopped)
                .and_then(|_| controls.set_metadata(MediaMetadata::default()))
        };
        if let Err(error) = updated {
            failure = Some(format!("System media controls failed: {error:?}"));
            state.controls = None;
        }
    }
    if menu_changed {
        if let Err(error) = refresh_menu(&app, &mut state) {
            failure = Some(error);
        }
    }
    if let Some(error) = failure {
        Err(error)
    } else {
        Ok(())
    }
}
pub fn keep_alive(app: &AppHandle) -> bool {
    app.state::<SurfaceState>()
        .lock()
        .map(|s| s.tray)
        .unwrap_or(false)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_accountless_metadata_and_unknown_kinds() {
        let recent = Recent {
            book_id: "b".into(),
            file_id: "f".into(),
            title: "Title".into(),
            author: "".into(),
            kind: "audio".into(),
            progress: 0.5,
        };
        assert!(validate(&Snapshot {
            recents: vec![recent.clone()],
            ..Default::default()
        })
        .is_err());
        let mut snapshot = Snapshot {
            account_scope: Some("[\"https://books.example\",\"7\"]".into()),
            recents: vec![recent],
            media: None,
        };
        assert!(validate(&snapshot).is_ok());
        snapshot.recents[0].kind = "shell".into();
        assert!(validate(&snapshot).is_err());
    }
    #[test]
    fn rejects_nonfinite_progress_and_oversized_scope() {
        let mut snapshot = Snapshot {
            account_scope: Some("[\"https://books.example\",\"7\"]".into()),
            recents: vec![],
            media: None,
        };
        snapshot.media = Some(Media {
            book_id: "b".into(),
            file_id: "f".into(),
            title: "Title".into(),
            author: "".into(),
            chapter: None,
            position: f64::NAN,
            duration: 12.0,
            playing: true,
        });
        assert!(validate(&snapshot).is_err());
        snapshot.media = None;
        snapshot.account_scope = Some("x".repeat(9000));
        assert!(validate(&snapshot).is_err());
    }
}
