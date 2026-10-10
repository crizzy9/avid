//! Durable, one-use native OIDC transactions and exact system-browser callbacks.
use crate::{
    desktop_io,
    vault::{NativeSessionRecord, VaultError},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;
use url::Url;
const REDIRECT: &str = "avid://oauth2-callback";
fn invalid() -> VaultError {
    VaultError::InvalidAuxiliary
}
fn string<'a>(value: &'a Value, key: &str, limit: usize) -> Result<&'a str, VaultError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= limit && !s.contains('\0'))
        .ok_or_else(invalid)
}
fn milliseconds() -> Result<f64, VaultError> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| invalid())?
        .as_secs_f64()
        * 1000.0)
}
fn active(record: &NativeSessionRecord, value: &Value, now: f64) -> bool {
    let Some(transaction) = value.get("transaction") else {
        return false;
    };
    let created = transaction
        .get("createdAt")
        .and_then(Value::as_f64)
        .unwrap_or(f64::NAN);
    let expires = transaction
        .get("expiresAt")
        .and_then(Value::as_f64)
        .unwrap_or(f64::NAN);
    created.is_finite()
        && expires.is_finite()
        && created <= now
        && now < expires
        && expires > created
        && expires - created <= 300_000.0
        && value.get("generation").and_then(Value::as_str) == Some(record.generation.as_str())
}
fn valid_transaction(transaction: &Value, routing: &Value, now: f64) -> Result<(), VaultError> {
    let secret = |key| {
        string(transaction, key, 43)
            .map(|s| {
                s.len() == 43
                    && s.bytes()
                        .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
            })
            .unwrap_or(false)
    };
    if transaction.get("version").and_then(Value::as_u64) != Some(1)
        || !secret("codeVerifier")
        || !secret("nonce")
        || string(transaction, "redirectUri", 2048)? != REDIRECT
        || string(transaction, "clientKind", 16)? != "native"
        || transaction
            .get("transportBaseUrl")
            .is_some_and(|v| !v.is_null())
    {
        return Err(invalid());
    }
    string(transaction, "state", 512)?;
    let server = string(transaction, "serverUrl", 8192)?;
    if desktop_io::normalize_server(server).map_err(|_| invalid())? != server {
        return Err(invalid());
    }
    let provider = string(transaction, "providerSlug", 512)?;
    if !provider
        .bytes()
        .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err(invalid());
    }
    let profile = routing.get("profile").ok_or_else(invalid)?;
    if string(transaction, "profileId", 2048)? != string(profile, "id", 2048)?
        || desktop_io::normalize_server(string(profile, "url", 8192)?).map_err(|_| invalid())?
            != server
        || string(routing, "provider", 512)? != provider
        || routing.get("readOnly").and_then(Value::as_bool).is_none()
    {
        return Err(invalid());
    }
    let created = transaction
        .get("createdAt")
        .and_then(Value::as_f64)
        .ok_or_else(invalid)?;
    let expires = transaction
        .get("expiresAt")
        .and_then(Value::as_f64)
        .ok_or_else(invalid)?;
    if !created.is_finite()
        || !expires.is_finite()
        || created > now
        || now >= expires
        || expires <= created
        || expires - created > 300_000.0
        || routing.get("createdAt").and_then(Value::as_f64) != Some(created)
    {
        return Err(invalid());
    }
    Ok(())
}
fn one(url: &Url, key: &str, limit: usize) -> Option<String> {
    let values: Vec<_> = url
        .query_pairs()
        .filter(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
        .collect();
    if values.len() != 1 || values[0].is_empty() || values[0].len() > limit {
        None
    } else {
        Some(values[0].clone())
    }
}
fn authorization(value: &Value, state: &str, raw: &str) -> Result<Url, VaultError> {
    if raw.len() > 16384 || value.get("callbackUrl").is_some() {
        return Err(invalid());
    }
    let url = Url::parse(raw).map_err(|_| invalid())?;
    if !["https", "http"].contains(&url.scheme())
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid());
    }
    let transaction = value.get("transaction").ok_or_else(invalid)?;
    let nonce = string(transaction, "nonce", 43)?;
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(
        string(transaction, "codeVerifier", 43)?.as_bytes(),
    ));
    for (key, expected) in [
        ("state", state),
        ("redirect_uri", REDIRECT),
        ("nonce", nonce),
        ("response_type", "code"),
        ("response_mode", "query"),
        ("code_challenge_method", "S256"),
        ("code_challenge", challenge.as_str()),
    ] {
        if one(&url, key, 8192).as_deref() != Some(expected) {
            return Err(invalid());
        }
    }
    if string(transaction, "state", 512)? != state
        || one(&url, "client_id", 4096).is_none()
        || !one(&url, "scope", 4096)
            .is_some_and(|scope| scope.split_whitespace().any(|s| s == "openid"))
    {
        return Err(invalid());
    }
    Ok(url)
}
fn callback(raw: &str) -> Option<String> {
    if raw.len() > 16384 || raw.split('?').next() != Some(REDIRECT) {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    if url.fragment().is_some() || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let state = one(&url, "state", 512)?;
    let codes: Vec<_> = url
        .query_pairs()
        .filter(|(k, _)| k == "code" || k == "error")
        .collect();
    if codes.len() != 1 || codes[0].1.is_empty() || codes[0].1.len() > 8192 {
        return None;
    }
    Some(state)
}
fn main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("This action requires Avid's main window.".into())
    }
}
async fn update<T: Send + 'static>(
    app: AppHandle,
    action: impl FnOnce(&NativeSessionRecord, Option<Value>) -> Result<(Option<Value>, T), VaultError>
        + Send
        + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || desktop_io::oidc_update(&app, action))
        .await
        .map_err(|_| "Secure sign-in storage is unavailable.".to_owned())?
}
fn accept(app: &AppHandle, raw: String) {
    let Some(state) = callback(&raw) else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let saved = update(app.clone(), move |record, old| {
            let Some(mut value) = old else {
                return Ok((None, false));
            };
            let now = milliseconds()?;
            if !active(record, &value, now) {
                return Ok((None, false));
            }
            if value.pointer("/transaction/state").and_then(Value::as_str) != Some(state.as_str()) {
                return Ok((Some(value), false));
            }
            if value.get("callbackUrl").is_some() {
                return Ok((Some(value), false));
            }
            value["callbackUrl"] = Value::String(raw);
            Ok((Some(value), true))
        })
        .await
        .unwrap_or(false);
        if saved {
            let _ = app.emit("avid:desktop-oidc-callback", json!({}));
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }
    });
}
fn callback_host_available() -> bool {
    #[cfg(target_os = "macos")]
    {
        std::env::current_exe()
            .ok()
            .and_then(|path| {
                path.parent()
                    .and_then(|p| p.parent())
                    .and_then(|p| p.parent())
                    .map(|p| p.extension().is_some_and(|e| e == "app"))
            })
            .unwrap_or(false)
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}
pub fn initialize(app: &AppHandle) {
    // Installed bundles declare avid in configuration. AppImage/Windows development
    // registration happens only when the user explicitly starts provider sign-in.
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        for url in urls {
            accept(app, url.to_string());
        }
    }
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            accept(&handle, url.to_string());
        }
    });
}
#[tauri::command]
pub async fn desktop_oidc_capabilities(
    window: WebviewWindow,
    app: AppHandle,
) -> Result<Value, String> {
    main_window(&window)?;
    update(app, |_, old| {
        Ok((
            old,
            json!({"redirectUri":REDIRECT,"secureTransactions":callback_host_available()}),
        ))
    })
    .await
}
#[tauri::command]
pub async fn desktop_oidc_save(
    window: WebviewWindow,
    app: AppHandle,
    request: Value,
) -> Result<(), String> {
    main_window(&window)?;
    update(app, move |record, old| {
        let transaction = request.get("transaction").ok_or_else(invalid)?;
        let routing = request.get("routing").ok_or_else(invalid)?;
        let now = milliseconds()?;
        valid_transaction(transaction, routing, now)?;
        if old
            .as_ref()
            .and_then(|old| old.pointer("/transaction/state"))
            == transaction.get("state")
        {
            return Err(invalid());
        }
        Ok((
            Some(
                json!({"transaction":transaction,"routing":routing,"generation":record.generation}),
            ),
            (),
        ))
    })
    .await
}
#[tauri::command]
pub async fn desktop_oidc_pending(window: WebviewWindow, app: AppHandle) -> Result<Value, String> {
    main_window(&window)?;
    update(app,|record,old|{
        let Some(value)=old else{return Ok((None,json!({})));};
        if !active(record,&value,milliseconds()?){return Ok((None,json!({})));}
        let mut pending=json!({"generation":value["generation"],"state":value["transaction"]["state"],"expiresAt":value["transaction"]["expiresAt"],"routing":value["routing"]});
        if let Some(callback)=value.get("callbackUrl"){pending["callbackUrl"]=callback.clone();}
        Ok((Some(value),json!({"pending":pending})))
    }).await
}
#[tauri::command]
pub async fn desktop_oidc_take(
    window: WebviewWindow,
    app: AppHandle,
    request: Value,
) -> Result<Value, String> {
    main_window(&window)?;
    update(app, move |record, old| {
        let state = string(&request, "state", 512)?;
        let Some(value) = old else {
            return Ok((None, json!({})));
        };
        if value.pointer("/transaction/state").and_then(Value::as_str) != Some(state) {
            return Ok((Some(value), json!({})));
        }
        let result = if active(record, &value, milliseconds()?) {
            json!({"transaction":value["transaction"]})
        } else {
            json!({})
        };
        Ok((None, result)) // Durable encrypted tombstone commits before returning PKCE.
    })
    .await
}
#[tauri::command]
pub async fn desktop_oidc_cancel(
    window: WebviewWindow,
    app: AppHandle,
    request: Value,
) -> Result<(), String> {
    main_window(&window)?;
    update(app, move |_, old| {
        if let Some(state) = request.get("state").and_then(Value::as_str) {
            if old
                .as_ref()
                .and_then(|old| old.pointer("/transaction/state"))
                .and_then(Value::as_str)
                != Some(state)
            {
                return Ok((old, ()));
            }
        }
        Ok((None, ()))
    })
    .await
}
#[tauri::command]
pub async fn desktop_oidc_open(
    window: WebviewWindow,
    app: AppHandle,
    request: Value,
) -> Result<(), String> {
    main_window(&window)?;
    if !callback_host_available() {
        return Err("Install the Avid application bundle to use provider sign-in.".into());
    }
    let url = update(app.clone(), move |record, old| {
        let value = old.ok_or_else(invalid)?;
        if !active(record, &value, milliseconds()?) {
            return Err(invalid());
        }
        let url = authorization(
            &value,
            string(&request, "state", 512)?,
            string(&request, "url", 16384)?,
        )?;
        Ok((Some(value), url.to_string()))
    })
    .await?;
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(any(target_os = "linux", windows))]
        app.deep_link().register_all().map_err(|_| {
            "Avid could not register its provider callback with this desktop.".to_owned()
        })?;
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|_| "The system authentication browser could not be opened.".to_owned())
    })
    .await
    .map_err(|_| "The system browser is unavailable.".to_owned())?
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (NativeSessionRecord, Value) {
        let record = NativeSessionRecord {
            generation: "generation".into(),
            session: None,
            read_only: None,
        };
        let value = json!({"generation":"generation","transaction":{"version":1,"state":"saved-state","providerSlug":"provider","profileId":"profile","serverUrl":"https://books.example","redirectUri":REDIRECT,"clientKind":"native","codeVerifier":"a".repeat(43),"nonce":"b".repeat(43),"createdAt":1000,"expiresAt":301000},"routing":{"profile":{"id":"profile","url":"https://books.example"},"provider":"provider","readOnly":true,"createdAt":1000}});
        (record, value)
    }
    #[test]
    fn rejects_stale_generations_and_expired_or_unbounded_lifetimes() {
        let (record, mut value) = fixture();
        assert!(active(&record, &value, 1001.0));
        assert!(!active(&record, &value, 301000.0));
        value["generation"] = json!("old");
        assert!(!active(&record, &value, 1001.0));
        value["generation"] = json!("generation");
        value["transaction"]["expiresAt"] = json!(301001);
        assert!(!active(&record, &value, 1001.0));
    }
    #[test]
    fn requires_exact_callback_without_ambiguous_parameters() {
        assert_eq!(
            callback("avid://oauth2-callback?state=saved-state&code=code"),
            Some("saved-state".into())
        );
        for raw in [
            "avid://wrong?state=x&code=y",
            "avid://oauth2-callback/?state=x&code=y",
            "avid://oauth2-callback?state=x&state=y&code=z",
            "avid://oauth2-callback?state=x&code=z&error=no",
            "avid://oauth2-callback?state=x&code=z#fragment",
        ] {
            assert_eq!(callback(raw), None);
        }
    }
    #[test]
    fn validates_profile_native_protocol_and_creation_binding() {
        let (_, mut value) = fixture();
        assert!(valid_transaction(&value["transaction"], &value["routing"], 1001.0).is_ok());
        value["transaction"]["clientKind"] = json!("web");
        assert!(valid_transaction(&value["transaction"], &value["routing"], 1001.0).is_err());
        value["transaction"]["clientKind"] = json!("native");
        value["routing"]["createdAt"] = json!(999);
        assert!(valid_transaction(&value["transaction"], &value["routing"], 1001.0).is_err());
    }
    #[test]
    fn authorization_must_match_real_pkce_challenge() {
        let (_, value) = fixture();
        let mut url = Url::parse("https://identity.example/authorize").unwrap();
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest("a".repeat(43).as_bytes()));
        url.query_pairs_mut().extend_pairs([
            ("state", "saved-state"),
            ("redirect_uri", REDIRECT),
            ("nonce", &"b".repeat(43)),
            ("response_type", "code"),
            ("response_mode", "query"),
            ("code_challenge_method", "S256"),
            ("code_challenge", &challenge),
            ("client_id", "client"),
            ("scope", "openid profile"),
        ]);
        assert!(authorization(&value, "saved-state", url.as_str()).is_ok());
        url.query_pairs_mut().append_pair("state", "another");
        assert!(authorization(&value, "saved-state", url.as_str()).is_err());
    }
}
