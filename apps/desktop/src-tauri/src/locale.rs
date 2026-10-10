use serde_json::Value;
use std::{fs, sync::{OnceLock, RwLock}};
use tauri::{AppHandle, Manager, WebviewWindow};
const LOCALES: [&str; 7] = ["en", "fi", "fr", "de", "pl", "zh-Hans", "es"];
static ACTIVE: RwLock<usize> = RwLock::new(0);
static MESSAGES: OnceLock<Value> = OnceLock::new();
pub fn text(key: &str) -> String {
    let index = ACTIVE.read().map(|v| *v).unwrap_or(0);
    let messages = MESSAGES.get_or_init(|| serde_json::from_str(include_str!("../../../../packages/i18n/native-messages.json")).expect("Bundled native translations must be valid"));
    index.checked_sub(1).and_then(|i| messages.get(key)?.get(i)?.as_str()).unwrap_or(key).to_string()
}
pub fn initialize(app: &AppHandle) {
    if let Ok(path) = app.path().app_config_dir() {
        if let Ok(value) = fs::read_to_string(path.join("locale.txt")) {
            if let Some(index) = LOCALES.iter().position(|locale| *locale == value.trim()) {
                if let Ok(mut active) = ACTIVE.write() { *active = index; }
            }
        }
    }
}
#[tauri::command]
pub fn desktop_set_appearance(window: WebviewWindow, app: AppHandle, theme: String, locale: String) -> Result<(), String> {
    crate::surfaces::main_window(&window)?;
    let index = LOCALES.iter().position(|value| *value == locale).ok_or("Unsupported language.")?;
    let theme = match theme.as_str() { "light" => Some(tauri::Theme::Light), "dark" => Some(tauri::Theme::Dark), "system" => None, _ => return Err("Unsupported appearance.".into()) };
    window.set_theme(theme).map_err(|e| e.to_string())?;
    let mut active = ACTIVE.write().map_err(|_| "Language settings are unavailable.")?;
    if *active == index { return Ok(()); }
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join("locale.txt"), &locale).map_err(|e| e.to_string())?;
    *active = index;
    drop(active);
    crate::surfaces::refresh_labels(&app)
}
