#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod speech;
mod surfaces;
mod spotlight;
mod vault;
mod desktop_io;
mod locale;
mod desktop_oidc;
mod library_storage;
mod crosspoint;
mod artwork;
use tauri::Manager;
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            desktop_io::initialize(app.handle());
            library_storage::initialize(app.handle());
            crosspoint::initialize(app.handle());
            desktop_oidc::initialize(app.handle());
            locale::initialize(app.handle());
            speech::initialize(app.handle());
            surfaces::initialize(app.handle());
            spotlight::initialize(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            surfaces::desktop_capabilities,
            locale::desktop_set_appearance,
            library_storage::library_storage_read,
            library_storage::library_storage_commit,
            library_storage::library_storage_blob_begin,
            library_storage::library_storage_blob_append,
            library_storage::library_storage_blob_finish,
            library_storage::library_storage_blob_read,
            library_storage::library_storage_blob_cancel,
            crosspoint::desktop_crosspoint_open,
            crosspoint::desktop_crosspoint_read,
            crosspoint::desktop_crosspoint_close,
            desktop_oidc::desktop_oidc_capabilities,
            desktop_oidc::desktop_oidc_save,
            desktop_oidc::desktop_oidc_take,
            desktop_oidc::desktop_oidc_pending,
            desktop_oidc::desktop_oidc_cancel,
            desktop_oidc::desktop_oidc_open,
            surfaces::desktop_publish,
            spotlight::desktop_spotlight,
            speech::desktop_speech_voices,
            speech::desktop_speech_speak,
            speech::desktop_speech_cancel,
            desktop_io::desktop_session_read,
            desktop_io::desktop_session_write,
            desktop_io::desktop_session_clear,
            desktop_io::desktop_authenticate,
            desktop_io::desktop_refresh,
            desktop_io::desktop_http_open,
            desktop_io::desktop_http_read,
            desktop_io::desktop_http_close,
            desktop_io::desktop_media_sources,
        ])
        .register_asynchronous_uri_scheme_protocol("avid-media", |ctx, request, responder| desktop_io::media_protocol(ctx.app_handle().clone(), ctx.webview_label(), request, responder))
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
