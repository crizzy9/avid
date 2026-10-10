#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod speech;
mod surfaces;
use tauri::Manager;
fn main() {
    tauri::Builder::default()
        .setup(|app| {
            speech::initialize(app.handle());
            surfaces::initialize(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            surfaces::desktop_capabilities,
            surfaces::desktop_publish,
            speech::desktop_speech_voices,
            speech::desktop_speech_speak,
            speech::desktop_speech_cancel
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if surfaces::keep_alive(window.app_handle()) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Avid could not initialize its desktop window");
}
