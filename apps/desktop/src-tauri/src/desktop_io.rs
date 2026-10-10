//! Native BookOrbit transport. Credentials remain in the OS-backed vault and never enter media URLs.
use crate::vault::{NativeSessionRecord, Vault};
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{header, Client, Method, Response};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tokio::sync::Mutex as AsyncMutex;
use url::Url;
use uuid::Uuid;

const CHUNK: usize = 256 * 1024;
const JSON_LIMIT: usize = 1024 * 1024;
const BODY_LIMIT: usize = 64 * 1024 * 1024;
const RANGE_LIMIT: u64 = 1000 * 1024;
#[derive(Clone)]
struct Binding {
    scope: String,
    epoch: u64,
}
struct Body {
    response: Response,
    pending: Vec<u8>,
    offset: usize,
    touched: Instant,
    binding: Option<Binding>,
}
#[derive(Clone)]
struct Media {
    url: Url,
    binding: Binding,
}
struct Resources {
    epoch: u64,
    bodies: HashMap<String, Arc<AsyncMutex<Body>>>,
    media: HashMap<String, Media>,
}
pub struct DesktopIo {
    vault: Result<Vault, String>,
    client: Result<Client, String>,
    resources: Mutex<Resources>,
    refresh: AsyncMutex<()>,
}
impl DesktopIo {
    fn vault(&self) -> Result<&Vault, String> {
        self.vault.as_ref().map_err(Clone::clone)
    }
    fn client(&self) -> Result<&Client, String> {
        self.client.as_ref().map_err(Clone::clone)
    }
    fn record(&self) -> Result<NativeSessionRecord, String> {
        self.vault()?
            .store
            .lock()
            .map_err(|_| "Secure session is unavailable.")?
            .read()
            .map_err(|e| e.to_string())
    }
    fn cached_record(&self) -> Result<NativeSessionRecord, String> {
        self.vault()?
            .store
            .lock()
            .map_err(|_| "Secure session is unavailable.")?
            .cached_record()
            .map_err(|e| e.to_string())
    }
    fn epoch(&self) -> Result<u64, String> {
        Ok(self
            .resources
            .lock()
            .map_err(|_| "Desktop transport is unavailable.")?
            .epoch)
    }
    fn binding(&self, scope: String) -> Result<Binding, String> {
        Ok(Binding {
            scope,
            epoch: self.epoch()?,
        })
    }
    fn verify(&self, binding: &Binding) -> Result<NativeSessionRecord, String> {
        if self.epoch()? != binding.epoch {
            return Err("The active connection changed.".into());
        }
        let record = self.cached_record()?;
        if scope_of(
            record
                .session
                .as_ref()
                .ok_or("Sign in to your book server.")?,
        )? != binding.scope
        {
            return Err("The active account changed.".into());
        }
        Ok(record)
    }
    fn reset_resources(&self) -> Result<(), String> {
        let mut resources = self
            .resources
            .lock()
            .map_err(|_| "Desktop transport is unavailable.")?;
        resources.epoch = resources.epoch.wrapping_add(1);
        resources.bodies.clear();
        resources.media.clear();
        Ok(())
    }
}
pub fn initialize(app: &AppHandle) {
    app.manage(DesktopIo {
        vault: Vault::from_app(app).map_err(|e| e.to_string()),
        client: Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(20))
            .read_timeout(Duration::from_secs(30))
            .build()
            .map_err(|_| "The native HTTP client is unavailable.".into()),
        resources: Mutex::new(Resources {
            epoch: 0,
            bodies: HashMap::new(),
            media: HashMap::new(),
        }),
        refresh: AsyncMutex::new(()),
    });
}
pub fn storage_epoch(app: &AppHandle) -> Result<u64, String> {
    app.state::<DesktopIo>().epoch()
}
pub fn with_storage_epoch<T>(
    app: &AppHandle,
    action: impl FnOnce(u64) -> Result<T, String>,
) -> Result<T, String> {
    let state = app.state::<DesktopIo>();
    let resources = state
        .resources
        .lock()
        .map_err(|_| "Desktop transport is unavailable.")?;
    action(resources.epoch)
}
pub fn active_account_scope(app: &AppHandle) -> Result<Option<String>, String> {
    let state = app.state::<DesktopIo>();
    state
        .vault()?
        .active_account_scope()
        .map_err(|e| e.to_string())
}
pub fn oidc_update<T>(
    app: &AppHandle,
    action: impl FnOnce(
        &NativeSessionRecord,
        Option<Value>,
    ) -> Result<(Option<Value>, T), crate::vault::VaultError>,
) -> Result<T, String> {
    let state = app.state::<DesktopIo>();
    let result = state
        .vault()?
        .store
        .lock()
        .map_err(|_| "Secure sign-in storage is unavailable.")?
        .auxiliary_update("oidc", action)
        .map_err(|e| e.to_string());
    result
}
fn main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("This action requires Avid's main window.".into())
    }
}
pub fn normalize_server(input: &str) -> Result<String, String> {
    let url = Url::parse(input.trim()).map_err(|_| "Invalid book server address.")?;
    if !["https", "http"].contains(&url.scheme())
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Use a server address without credentials, query, or fragment.".into());
    }
    let value = url.as_str().trim_end_matches('/');
    Ok(value.strip_suffix("/api/v1").unwrap_or(value).to_owned())
}
fn scope_of(session: &Value) -> Result<String, String> {
    let server = session
        .pointer("/profile/url")
        .and_then(Value::as_str)
        .ok_or("The secure session has no server.")?;
    let user = session
        .get("userId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("The secure session has no user.")?;
    serde_json::to_string(&[normalize_server(server)?, user.to_owned()])
        .map_err(|_| "Invalid account identity.".into())
}
fn token(session: &Value) -> Result<&str, String> {
    session
        .get("accessToken")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "The secure session has no access token.".into())
}
fn server_api(url: &Url, session: &Value) -> Result<bool, String> {
    let base = normalize_server(
        session
            .pointer("/profile/url")
            .and_then(Value::as_str)
            .ok_or("Missing server.")?,
    )?;
    Ok(url.as_str().starts_with(&(base + "/api/v1/")))
}
fn valid_url(raw: &str) -> Result<Url, String> {
    if raw.len() > 16384 {
        return Err("The request address is too long.".into());
    }
    let url = Url::parse(raw).map_err(|_| "Invalid request address.")?;
    if !["http", "https"].contains(&url.scheme())
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("Unsupported native HTTP address.".into());
    }
    Ok(url)
}
fn public_request(url: &Url, method: &str) -> bool {
    url.query().is_none()
        && ((method == "GET" && url.path().ends_with("/api/v1/auth/login-options"))
            || (method == "POST"
                && url
                    .path()
                    .rsplit_once("/api/v1/auth/oidc/")
                    .map(|(_, tail)| {
                        tail.strip_suffix("/state")
                            .map(|slug| {
                                !slug.is_empty()
                                    && slug.bytes().all(|b| {
                                        b.is_ascii_alphanumeric() || b == b'-' || b == b'_'
                                    })
                            })
                            .unwrap_or(false)
                    })
                    .unwrap_or(false)))
}
async fn limited_json(mut response: Response, limit: usize) -> Result<(u16, Value), String> {
    let status = response.status().as_u16();
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err("The authentication response is too large.".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "The server response was interrupted.")?
    {
        if bytes.len() + chunk.len() > limit {
            return Err("The authentication response is too large.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes)
            .map_err(|_| "The server returned an invalid authentication response.")?
    };
    Ok((status, body))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionWrite {
    expected_generation: String,
    session: Value,
    read_only: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionClear {
    expected_generation: Option<String>,
}
#[tauri::command]
pub fn desktop_session_read(
    window: WebviewWindow,
    state: State<'_, DesktopIo>,
) -> Result<NativeSessionRecord, String> {
    main_window(&window)?;
    state
        .vault()?
        .store
        .lock()
        .map_err(|_| "Secure session is unavailable.")?
        .read()
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn desktop_session_write(
    window: WebviewWindow,
    state: State<'_, DesktopIo>,
    request: SessionWrite,
) -> Result<NativeSessionRecord, String> {
    main_window(&window)?;
    let (prior_scope, next) = {
        let mut store = state
            .vault()?
            .store
            .lock()
            .map_err(|_| "Secure session is unavailable.")?;
        let previous = store.cached_record().map_err(|e| e.to_string())?;
        let prior_scope = previous.session.as_ref().map(scope_of).transpose()?;
        let next = store
            .write(
                &request.expected_generation,
                request.session,
                request.read_only,
            )
            .map_err(|e| e.to_string())?;
        (prior_scope, next)
    };
    if prior_scope != next.session.as_ref().map(scope_of).transpose()? {
        state.reset_resources()?;
    }
    Ok(next)
}
#[tauri::command]
pub fn desktop_session_clear(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, DesktopIo>,
    request: SessionClear,
) -> Result<NativeSessionRecord, String> {
    main_window(&window)?;
    let next = state
        .vault()?
        .store
        .lock()
        .map_err(|_| "Secure session is unavailable.")?
        .clear(request.expected_generation.as_deref())
        .map_err(|e| e.to_string())?;
    state.reset_resources()?;
    let _ = crate::spotlight::clear(&app);
    let _ = crate::surfaces::clear(&app);
    Ok(next)
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Authentication {
    expected_generation: String,
    server_url: String,
    path: String,
    body: String,
}
#[derive(Serialize)]
pub struct AuthenticationResponse {
    status: u16,
    body: Value,
}
#[tauri::command]
pub async fn desktop_authenticate(
    window: WebviewWindow,
    state: State<'_, DesktopIo>,
    request: Authentication,
) -> Result<AuthenticationResponse, String> {
    main_window(&window)?;
    if !["login", "oidc/callback"].contains(&request.path.as_str())
        || request.body.len() > JSON_LIMIT
    {
        return Err("Invalid authentication request.".into());
    }
    let payload: Value =
        serde_json::from_str(&request.body).map_err(|_| "Invalid authentication request.")?;
    if payload.get("clientKind").and_then(Value::as_str) != Some("native") {
        return Err("Desktop sign-in requires the native server session protocol.".into());
    }
    if state.record()?.generation != request.expected_generation {
        return Err("This sign-in attempt is no longer active.".into());
    }
    let endpoint = format!(
        "{}/api/v1/auth/{}",
        normalize_server(&request.server_url)?,
        request.path
    );
    let response = state
        .client()?
        .post(endpoint)
        .json(&payload)
        .send()
        .await
        .map_err(|_| "The book server could not be reached.")?;
    let (status, body) = limited_json(response, JSON_LIMIT).await?;
    if state.record()?.generation != request.expected_generation {
        return Err("This sign-in attempt is no longer active.".into());
    }
    // The login result is committed only by the root's validated session adoption, never by HTTP cookies.
    Ok(AuthenticationResponse { status, body })
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RefreshRequest {
    account_scope: String,
    expected_generation: Option<String>,
    force: Option<bool>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionChanged {
    account_scope: String,
    generation: String,
}
async fn refresh(
    app: &AppHandle,
    state: &DesktopIo,
    request: RefreshRequest,
) -> Result<NativeSessionRecord, String> {
    let before = state.record()?;
    if request
        .expected_generation
        .as_ref()
        .is_some_and(|g| g != &before.generation)
    {
        return Err("The secure session changed before renewal.".into());
    }
    let original = before
        .session
        .as_ref()
        .ok_or("Sign in again to renew this connection.")?;
    if scope_of(original)? != request.account_scope {
        return Err("The active account changed.".into());
    }
    let _flight = state.refresh.lock().await;
    let current = state.record()?;
    let session = current
        .session
        .as_ref()
        .ok_or("Sign in again to renew this connection.")?;
    if scope_of(session)? != request.account_scope {
        return Err("The active account changed.".into());
    }
    if token(original)? != token(session)? {
        return Ok(current);
    }
    if request.force == Some(false) {
        return Ok(current);
    }
    let refresh_token = session
        .get("refreshToken")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("The saved native refresh token is unavailable. Sign in again.")?;
    let server = normalize_server(
        session
            .pointer("/profile/url")
            .and_then(Value::as_str)
            .ok_or("Missing server.")?,
    )?;
    let response = state
        .client()?
        .post(format!("{server}/api/v1/auth/refresh"))
        .json(&json!({"refreshToken":refresh_token}))
        .send()
        .await
        .map_err(|_| "Credential renewal could not reach the server.")?;
    let (status, body) = limited_json(response, JSON_LIMIT).await?;
    if !(200..300).contains(&status) {
        return Err("The book server rejected credential renewal. Sign in again.".into());
    }
    let new_token = body
        .get("accessToken")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("The server returned no refreshed access token.")?;
    let response = state
        .client()?
        .get(format!("{server}/api/v1/auth/me"))
        .bearer_auth(new_token)
        .send()
        .await
        .map_err(|_| "The renewed identity could not be verified.")?;
    let (status, identity) = limited_json(response, JSON_LIMIT).await?;
    let user = identity.get("id").map(|id| {
        id.as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| id.to_string())
    });
    if status != 200
        || identity.get("active").and_then(Value::as_bool) != Some(true)
        || user.as_deref() != session.get("userId").and_then(Value::as_str)
    {
        return Err("The refreshed session did not match the active user.".into());
    }
    let mut next = session.clone();
    next["accessToken"] = Value::String(new_token.to_owned());
    if let Some(value) = body
        .get("refreshToken")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        next["refreshToken"] = Value::String(value.to_owned());
    }
    let record = state
        .vault()?
        .store
        .lock()
        .map_err(|_| "Secure session is unavailable.")?
        .write(&current.generation, next, current.read_only.unwrap_or(true))
        .map_err(|e| e.to_string())?;
    let _ = app.emit(
        "avid:desktop-session",
        SessionChanged {
            account_scope: request.account_scope,
            generation: record.generation.clone(),
        },
    );
    Ok(record)
}
#[tauri::command]
pub async fn desktop_refresh(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, DesktopIo>,
    request: RefreshRequest,
) -> Result<NativeSessionRecord, String> {
    main_window(&window)?;
    refresh(&app, &state, request).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HttpRequest {
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body_base64: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    id: String,
    status: u16,
    status_text: String,
    headers: Vec<(String, String)>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BodyRequest {
    id: String,
}
#[derive(Serialize)]
pub struct BodyRead {
    bytes: Vec<u8>,
    done: bool,
}
#[tauri::command]
pub async fn desktop_http_open(
    window: WebviewWindow,
    state: State<'_, DesktopIo>,
    request: HttpRequest,
) -> Result<HttpResponse, String> {
    main_window(&window)?;
    let url = valid_url(&request.url)?;
    if request.headers.len() > 64
        || !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].contains(&request.method.as_str())
    {
        return Err("Unsupported request method or headers.".into());
    }
    let mut builder = state.client()?.request(
        Method::from_bytes(request.method.as_bytes()).map_err(|_| "Invalid method.")?,
        url.clone(),
    );
    for (key, value) in request.headers {
        if key.len() > 128 || value.len() > 8192 {
            return Err("A request header is too large.".into());
        }
        if [
            "accept",
            "content-type",
            "range",
            "if-none-match",
            "if-match",
            "if-modified-since",
        ]
        .contains(&key.to_ascii_lowercase().as_str())
        {
            builder = builder.header(&key, &value);
        }
    }
    let binding = if public_request(&url, &request.method) {
        None
    } else {
        let record = state.record()?;
        let session = record
            .session
            .as_ref()
            .ok_or("Sign in before requesting protected server data.")?;
        if !server_api(&url, session)? {
            return Err("This request does not belong to the active book server.".into());
        }
        if !["GET", "HEAD"].contains(&request.method.as_str())
            && record.read_only.unwrap_or(true)
            && !url.path().ends_with("/auth/logout")
        {
            return Err("This connection is read-only.".into());
        }
        builder = builder.bearer_auth(token(session)?);
        Some(state.binding(scope_of(session)?)?)
    };
    if let Some(body) = request.body_base64 {
        if body.len() > 4 * ((BODY_LIMIT + 2) / 3) {
            return Err("The upload exceeds the native 64 MiB request limit.".into());
        }
        let bytes = STANDARD
            .decode(body)
            .map_err(|_| "Invalid request bytes.")?;
        if bytes.len() > BODY_LIMIT {
            return Err("The upload exceeds the native 64 MiB request limit.".into());
        }
        builder = builder.body(bytes);
    }
    let response = builder
        .send()
        .await
        .map_err(|_| "The book server request failed or timed out.")?;
    if let Some(binding) = &binding {
        state.verify(binding)?;
    }
    let result = HttpResponse {
        id: Uuid::new_v4().to_string(),
        status: response.status().as_u16(),
        status_text: response
            .status()
            .canonical_reason()
            .unwrap_or("")
            .to_owned(),
        headers: response
            .headers()
            .iter()
            .filter(|(key, _)| key.as_str() != "set-cookie")
            .filter_map(|(key, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|v| (key.as_str().to_owned(), v.to_owned()))
            })
            .collect(),
    };
    let body = Body {
        response,
        pending: Vec::new(),
        offset: 0,
        touched: Instant::now(),
        binding,
    };
    let mut resources = state
        .resources
        .lock()
        .map_err(|_| "Desktop transport is unavailable.")?;
    resources.bodies.retain(|_, body| {
        body.try_lock()
            .map(|body| body.touched.elapsed() < Duration::from_secs(120))
            .unwrap_or(true)
    });
    if resources.bodies.len() >= 16 {
        return Err(
            "Too many active native requests. Close an existing download and retry.".into(),
        );
    }
    resources
        .bodies
        .insert(result.id.clone(), Arc::new(AsyncMutex::new(body)));
    Ok(result)
}
#[tauri::command]
pub async fn desktop_http_read(
    window: WebviewWindow,
    state: State<'_, DesktopIo>,
    request: BodyRequest,
) -> Result<BodyRead, String> {
    main_window(&window)?;
    let resource = state
        .resources
        .lock()
        .map_err(|_| "Desktop transport is unavailable.")?
        .bodies
        .get(&request.id)
        .cloned()
        .ok_or("This response has closed.")?;
    let mut body = resource.lock().await;
    if let Some(binding) = &body.binding {
        state.verify(binding)?;
    }
    body.touched = Instant::now();
    if body.offset >= body.pending.len() {
        match body
            .response
            .chunk()
            .await
            .map_err(|_| "The server response was interrupted.")?
        {
            Some(bytes) => {
                body.pending = bytes.to_vec();
                body.offset = 0;
            }
            None => {
                state
                    .resources
                    .lock()
                    .map_err(|_| "Desktop transport is unavailable.")?
                    .bodies
                    .remove(&request.id);
                return Ok(BodyRead {
                    bytes: Vec::new(),
                    done: true,
                });
            }
        }
    }
    if let Some(binding) = &body.binding {
        state.verify(binding)?;
    }
    let end = (body.offset + CHUNK).min(body.pending.len());
    let bytes = body.pending[body.offset..end].to_vec();
    body.offset = end;
    Ok(BodyRead { bytes, done: false })
}
#[tauri::command]
pub fn desktop_http_close(
    window: WebviewWindow,
    state: State<'_, DesktopIo>,
    request: BodyRequest,
) -> Result<(), String> {
    main_window(&window)?;
    state
        .resources
        .lock()
        .map_err(|_| "Desktop transport is unavailable.")?
        .bodies
        .remove(&request.id);
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaRequest {
    account_scope: String,
    urls: Vec<String>,
}
#[derive(Serialize)]
pub struct MediaResponse {
    ids: Vec<String>,
}
#[tauri::command]
pub fn desktop_media_sources(
    window: WebviewWindow,
    state: State<'_, DesktopIo>,
    request: MediaRequest,
) -> Result<MediaResponse, String> {
    main_window(&window)?;
    if request.urls.is_empty() || request.urls.len() > 1000 {
        return Err("An audiobook must contain 1–1000 sources.".into());
    }
    let binding = state.binding(request.account_scope)?;
    let record = state.verify(&binding)?;
    let session = record
        .session
        .as_ref()
        .ok_or("Sign in before preparing server audio.")?;
    let mut sources = Vec::new();
    for raw in request.urls {
        let url = valid_url(&raw)?;
        if !server_api(&url, session)? {
            return Err("An audio source does not belong to the active server.".into());
        }
        sources.push(url);
    }
    let mut resources = state
        .resources
        .lock()
        .map_err(|_| "Desktop transport is unavailable.")?;
    // Active source mappings are ephemeral, scoped, and contain no token in their public handle.
    resources.media.clear();
    let mut ids = Vec::new();
    for url in sources {
        let id = Uuid::new_v4().to_string();
        resources.media.insert(
            id.clone(),
            Media {
                url,
                binding: binding.clone(),
            },
        );
        ids.push(id);
    }
    Ok(MediaResponse { ids })
}
fn range_header(value: Option<&str>) -> Result<String, String> {
    let Some(value) = value else {
        return Ok(format!("bytes=0-{}", RANGE_LIMIT - 1));
    };
    let raw = value
        .strip_prefix("bytes=")
        .ok_or("Unsupported media range.")?;
    if raw.contains(',') {
        return Err("Multipart media ranges are unsupported.".into());
    }
    let (start, end) = raw.split_once('-').ok_or("Invalid media range.")?;
    if start.is_empty() {
        let suffix: u64 = end.parse().map_err(|_| "Invalid media suffix range.")?;
        if suffix == 0 {
            return Err("Invalid media suffix range.".into());
        }
        return Ok(format!("bytes=-{}", suffix.min(RANGE_LIMIT)));
    }
    let start: u64 = start.parse().map_err(|_| "Invalid media range start.")?;
    let maximum = start
        .checked_add(RANGE_LIMIT - 1)
        .ok_or("Media range overflow.")?;
    let end = if end.is_empty() {
        maximum
    } else {
        end.parse::<u64>()
            .map_err(|_| "Invalid media range end.")?
            .min(maximum)
    };
    if end < start {
        return Err("Invalid media range order.".into());
    }
    Ok(format!("bytes={start}-{end}"))
}
async fn media_response(
    app: &AppHandle,
    request: tauri::http::Request<Vec<u8>>,
) -> Result<tauri::http::Response<Vec<u8>>, String> {
    if !["GET", "HEAD"].contains(&request.method().as_str()) {
        return Err("Unsupported media method.".into());
    }
    let id = request.uri().path().trim_start_matches('/');
    let state = app.state::<DesktopIo>();
    let source = state
        .resources
        .lock()
        .map_err(|_| "Desktop transport is unavailable.")?
        .media
        .get(id)
        .cloned()
        .ok_or("This media source has closed.")?;
    let record = state.verify(&source.binding)?;
    let session = record.session.as_ref().ok_or("Sign in before playback.")?;
    let range = range_header(request.headers().get("range").and_then(|v| v.to_str().ok()))?;
    let method = if request.method() == "HEAD" {
        Method::HEAD
    } else {
        Method::GET
    };
    let send = |token: String| {
        state.client().map(|client| {
            client
                .request(method.clone(), source.url.clone())
                .bearer_auth(token)
                .header(header::RANGE, &range)
        })
    };
    let mut response = send(token(session)?.to_owned())?
        .send()
        .await
        .map_err(|_| "The audio source could not be reached.")?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        let current = state.verify(&source.binding)?;
        // A delayed 401 for a superseded token must not rotate its replacement again.
        let renewed = if token(current.session.as_ref().ok_or("Sign in before playback.")?)?
            != token(session)?
        {
            current
        } else {
            refresh(
                app,
                &state,
                RefreshRequest {
                    account_scope: source.binding.scope.clone(),
                    expected_generation: None,
                    force: Some(true),
                },
            )
            .await?
        };
        state.verify(&source.binding)?;
        response =
            send(token(renewed.session.as_ref().ok_or("Sign in before playback.")?)?.to_owned())?
                .send()
                .await
                .map_err(|_| "The renewed audio request failed.")?;
    }
    state.verify(&source.binding)?;
    let status = response.status().as_u16();
    if ![200, 206, 416].contains(&status) {
        return Err("The audio server rejected the request.".into());
    }
    let mut result = tauri::http::Response::builder()
        .status(status)
        .header("Access-Control-Allow-Origin", "*")
        .header(
            "Access-Control-Expose-Headers",
            "Content-Range,Accept-Ranges,Content-Length",
        )
        .header("Cache-Control", "no-store");
    for name in [
        "content-type",
        "content-length",
        "content-range",
        "accept-ranges",
    ] {
        if let Some(value) = response.headers().get(name) {
            result = result.header(name, value);
        }
    }
    if request.method() == "HEAD" {
        return result
            .body(Vec::new())
            .map_err(|_| "Invalid audio response.".into());
    }
    if response
        .content_length()
        .is_some_and(|size| size > RANGE_LIMIT)
    {
        return Err("The audio server did not honor a bounded range request.".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "The audio response was interrupted.")?
    {
        if bytes.len() + chunk.len() > RANGE_LIMIT as usize {
            return Err("The audio server did not honor a bounded range request.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    state.verify(&source.binding)?;
    result
        .body(bytes)
        .map_err(|_| "Invalid audio response.".into())
}
pub fn media_protocol(
    app: AppHandle,
    label: &str,
    request: tauri::http::Request<Vec<u8>>,
    responder: tauri::UriSchemeResponder,
) {
    if label != "main" {
        responder.respond(
            tauri::http::Response::builder()
                .status(403)
                .body(Vec::<u8>::new())
                .unwrap(),
        );
        return;
    }
    tauri::async_runtime::spawn(async move {
        let response = media_response(&app, request).await.unwrap_or_else(|_| {
            tauri::http::Response::builder()
                .status(502)
                .header("Cache-Control", "no-store")
                .body(Vec::new())
                .unwrap()
        });
        responder.respond(response);
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn response_fixture(response: &'static str) -> (String, std::thread::JoinHandle<()>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        let task = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 4096];
            let _ = stream.read(&mut request);
            stream.write_all(response.as_bytes()).unwrap();
        });
        (url, task)
    }
    #[test]
    fn actual_http_json_reader_enforces_declared_and_streamed_limits() {
        tauri::async_runtime::block_on(async {
            let client = Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap();
            let (url, server) = response_fixture(
                "HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{\"ok\":true}",
            );
            let result = limited_json(client.get(url).send().await.unwrap(), 32)
                .await
                .unwrap();
            server.join().unwrap();
            assert_eq!(result, (200, json!({"ok":true})));
            let (url, server) = response_fixture(
                "HTTP/1.1 200 OK\r\nContent-Length: 999999\r\nConnection: close\r\n\r\n",
            );
            assert!(limited_json(client.get(url).send().await.unwrap(), 32)
                .await
                .is_err());
            server.join().unwrap();
            let (url,server)=response_fixture("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n10\r\n1234567890123456\r\n10\r\n1234567890123456\r\n0\r\n\r\n");
            assert!(limited_json(client.get(url).send().await.unwrap(), 20)
                .await
                .is_err());
            server.join().unwrap();
        });
    }
    #[test]
    fn ranges_are_bounded_and_overflow_safe() {
        assert_eq!(range_header(None).unwrap(), "bytes=0-1023999");
        assert_eq!(
            range_header(Some("bytes=100-2000000")).unwrap(),
            "bytes=100-1024099"
        );
        assert_eq!(
            range_header(Some("bytes=-2000000")).unwrap(),
            "bytes=-1024000"
        );
        for range in [
            "bytes=2-1",
            "bytes=0-1,4-9",
            "bytes=-0",
            "bytes=18446744073709551615-",
            "junk",
        ] {
            assert!(range_header(Some(range)).is_err());
        }
    }
    #[test]
    fn credentials_cannot_follow_a_lookalike_origin_or_unrelated_path() {
        let session = json!({"profile":{"url":"https://books.example/base/api/v1"},"userId":"7"});
        assert!(server_api(
            &Url::parse("https://books.example/base/api/v1/books").unwrap(),
            &session
        )
        .unwrap());
        for url in [
            "https://books.example.evil/base/api/v1/books",
            "https://books.example/api/v1/books",
            "https://books.example/base/api/v1evil/books",
            "http://books.example/base/api/v1/books",
        ] {
            assert!(!server_api(&Url::parse(url).unwrap(), &session).unwrap());
        }
        assert!(valid_url("https://user:secret@books.example/api/v1/books").is_err());
    }
    #[test]
    fn public_routes_cannot_smuggle_an_authenticated_operation() {
        assert!(public_request(
            &Url::parse("https://books.example/api/v1/auth/login-options").unwrap(),
            "GET"
        ));
        assert!(public_request(
            &Url::parse("https://books.example/api/v1/auth/oidc/provider/state").unwrap(),
            "POST"
        ));
        assert!(!public_request(
            &Url::parse("https://books.example/api/v1/auth/oidc/provider/callback").unwrap(),
            "POST"
        ));
        assert!(!public_request(
            &Url::parse("https://books.example/api/v1/auth/login-options?other=true").unwrap(),
            "GET"
        ));
    }
}
