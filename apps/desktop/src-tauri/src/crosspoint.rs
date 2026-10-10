//! CrossPoint-only LAN transport. No credential store, cookies, redirects or retries.
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::{Client, Response};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tokio::sync::{Mutex as AsyncMutex, Notify};
use url::Url;
const CHUNK: usize = 256 * 1024;
const FILE_LIMIT: usize = 64 * 1024 * 1024;
const UPLOAD_LIMIT: usize = FILE_LIMIT + 64 * 1024;
struct Transfer {
    cancelled: AtomicBool,
    wake: Notify,
    touched: Instant,
    body: AsyncMutex<Option<Body>>,
}
struct Body {
    response: Response,
    pending: Vec<u8>,
    offset: usize,
    read: usize,
    limit: usize,
}
#[derive(Default)]
pub struct CrossPoint {
    transfers: Mutex<HashMap<String, Arc<Transfer>>>,
    cancelled: Mutex<HashMap<String, Instant>>,
}
pub fn initialize(app: &AppHandle) {
    app.manage(CrossPoint::default());
}
fn main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("This action requires Avid's main window.".into())
    }
}
fn id_valid(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok()
}
fn lan(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => ip.is_private() || ip.is_loopback() || ip.is_link_local(),
        IpAddr::V6(ip) => {
            ip.is_loopback()
                || ip.is_unique_local()
                || ip.is_unicast_link_local()
                || ip.to_ipv4_mapped().is_some_and(|ip| lan(IpAddr::V4(ip)))
        }
    }
}
fn path_valid(path: &str) -> bool {
    path.starts_with('/')
        && path.len() <= 4096
        && !path
            .chars()
            .any(|c| c.is_control() || "\\%<>:\"|?*".contains(c))
        && path.split('/').filter(|s| !s.is_empty()).all(|s| {
            !s.starts_with('.')
                && !s.ends_with(['.', ' '])
                && !["system volume information", "xtcache"].contains(&s.to_lowercase().as_str())
        })
}
fn route(raw: &str, method: &str) -> Result<(Url, usize), String> {
    if raw.len() > 16384 {
        return Err("The reader address is too long.".into());
    }
    let url = Url::parse(raw).map_err(|_| "Invalid reader address.")?;
    if !["http", "https"].contains(&url.scheme())
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("Use a reader address without credentials or a fragment.".into());
    }
    let query: Vec<_> = url.query_pairs().collect();
    let limit = match (method, url.path()) {
        ("GET", "/api/status")
            if query.len() == 1 && query[0].0 == "plugin" && query[0].1 == "avid" =>
        {
            64 * 1024
        }
        ("GET", "/api/files")
            if query.len() == 1 && query[0].0 == "path" && path_valid(&query[0].1) =>
        {
            2 * 1024 * 1024
        }
        ("GET", "/download")
            if query.len() == 1
                && query[0].0 == "path"
                && path_valid(&query[0].1)
                && query[0].1.to_ascii_lowercase().ends_with(".epub") =>
        {
            FILE_LIMIT
        }
        ("POST", "/upload")
            if query.len() == 1 && query[0].0 == "path" && path_valid(&query[0].1) =>
        {
            64 * 1024
        }
        _ => {
            return Err(
                "This native transport supports only the pinned CrossPoint transfer routes.".into(),
            )
        }
    };
    Ok((url, limit))
}
async fn client(url: &Url) -> Result<Client, String> {
    let host = url.host_str().ok_or("Invalid reader address.")?;
    let port = url.port_or_known_default().ok_or("Invalid reader port.")?;
    let addrs: Vec<SocketAddr> = match url.host().ok_or("Invalid reader address.")? {
        url::Host::Ipv4(ip) => vec![SocketAddr::new(IpAddr::V4(ip), port)],
        url::Host::Ipv6(ip) => vec![SocketAddr::new(IpAddr::V6(ip), port)],
        url::Host::Domain(host) => tokio::net::lookup_host((host, port))
            .await
            .map_err(|_| "The reader hostname could not be resolved. Use the IP on its screen.")?
            .collect(),
    };
    if addrs.is_empty() || addrs.len() > 32 || addrs.iter().any(|address| !lan(address.ip())) {
        return Err("CrossPoint must resolve to a local-network address.".into());
    }
    Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(35))
        .resolve_to_addrs(host, &addrs)
        .build()
        .map_err(|_| "The local-network transport is unavailable.".into())
}
impl CrossPoint {
    fn begin(&self, id: &str) -> Result<Arc<Transfer>, String> {
        if !id_valid(id) {
            return Err("Invalid transfer ID.".into());
        }
        let mut cancelled = self
            .cancelled
            .lock()
            .map_err(|_| "Transfer state is unavailable.")?;
        cancelled.retain(|_, time| time.elapsed() < Duration::from_secs(120));
        if cancelled.contains_key(id) {
            return Err("The reader request was canceled.".into());
        }
        if cancelled.len() >= 256 {
            return Err(
                "Too many recent reader requests. Wait before starting another transfer.".into(),
            );
        }
        let mut transfers = self
            .transfers
            .lock()
            .map_err(|_| "Transfer state is unavailable.")?;
        transfers.retain(|_, transfer| transfer.touched.elapsed() < Duration::from_secs(120));
        if transfers.len() >= 8 || transfers.contains_key(id) {
            return Err("Too many active reader requests or a repeated transfer ID.".into());
        }
        let transfer = Arc::new(Transfer {
            cancelled: AtomicBool::new(false),
            wake: Notify::new(),
            touched: Instant::now(),
            body: AsyncMutex::new(None),
        });
        transfers.insert(id.to_owned(), transfer.clone());
        Ok(transfer)
    }
    fn close(&self, id: &str) -> Result<(), String> {
        if !id_valid(id) {
            return Err("Invalid transfer ID.".into());
        }
        let mut cancelled = self
            .cancelled
            .lock()
            .map_err(|_| "Transfer state is unavailable.")?;
        cancelled.retain(|_, time| time.elapsed() < Duration::from_secs(120));
        if cancelled.len() < 256 || cancelled.contains_key(id) {
            cancelled.insert(id.to_owned(), Instant::now());
        }
        if let Some(transfer) = self
            .transfers
            .lock()
            .map_err(|_| "Transfer state is unavailable.")?
            .remove(id)
        {
            transfer.cancelled.store(true, Ordering::Release);
            transfer.wake.notify_waiters();
        }
        Ok(())
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Open {
    id: String,
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body_base64: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Head {
    id: String,
    status: u16,
    status_text: String,
    headers: Vec<(String, String)>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Handle {
    id: String,
}
#[derive(Serialize)]
pub struct Chunk {
    bytes: Vec<u8>,
    done: bool,
}
async fn send(request: Open, transfer: &Transfer) -> Result<Head, String> {
    let (url, limit) = route(&request.url, &request.method)?;
    if request.headers.len() > 16 {
        return Err("Too many reader request headers.".into());
    }
    let mut builder = client(&url).await?.request(
        reqwest::Method::from_bytes(request.method.as_bytes())
            .map_err(|_| "Invalid reader method.")?,
        url,
    );
    let content: Vec<_> = request
        .headers
        .iter()
        .filter(|(name, _)| name.eq_ignore_ascii_case("content-type"))
        .collect();
    if request.method == "POST" {
        if content.len() != 1
            || !content[0].1.starts_with("multipart/form-data; boundary=")
            || content[0].1.len() > 256
            || content[0].1.contains(['\r', '\n'])
        {
            return Err("A reader upload must be a bounded multipart form.".into());
        }
        let encoded = request.body_base64.ok_or("An upload needs EPUB bytes.")?;
        if encoded.len() > 4 * ((UPLOAD_LIMIT + 2) / 3) {
            return Err("The EPUB upload exceeds 64 MiB.".into());
        }
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|_| "Invalid upload bytes.")?;
        if bytes.is_empty() || bytes.len() > UPLOAD_LIMIT {
            return Err("The EPUB upload exceeds 64 MiB.".into());
        }
        builder = builder.header("content-type", &content[0].1).body(bytes);
    } else if request.body_base64.is_some() {
        return Err("Reader inspection cannot contain an upload.".into());
    }
    // No caller headers other than a multipart boundary are forwarded.
    let response=builder.send().await.map_err(|_|"The reader request failed or timed out. An upload may have reached the device; verify before sending again.")?;
    if response.status().is_redirection() {
        return Err("The reader redirected the request. No redirected request was sent.".into());
    }
    if response
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
        return Err("The reader response exceeds the transfer limit.".into());
    }
    let head = Head {
        id: request.id,
        status: response.status().as_u16(),
        status_text: response
            .status()
            .canonical_reason()
            .unwrap_or("")
            .to_owned(),
        headers: response
            .headers()
            .iter()
            .filter(|(name, _)| ["content-type", "content-length"].contains(&name.as_str()))
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|value| (name.to_string(), value.to_string()))
            })
            .collect(),
    };
    *transfer.body.lock().await = Some(Body {
        response,
        pending: Vec::new(),
        offset: 0,
        read: 0,
        limit,
    });
    Ok(head)
}
#[tauri::command]
pub async fn desktop_crosspoint_open(
    window: WebviewWindow,
    state: State<'_, CrossPoint>,
    request: Open,
) -> Result<Head, String> {
    main_window(&window)?;
    let id = request.id.clone();
    let transfer = state.begin(&id)?;
    let cancelled = transfer.wake.notified();
    tokio::pin!(cancelled);
    cancelled.as_mut().enable();
    let result = if transfer.cancelled.load(Ordering::Acquire) {
        Err("The reader request was canceled.".into())
    } else {
        tokio::select! {result=send(request,&transfer)=>result,_=cancelled=>Err("The reader request was canceled. Verify an attempted upload before sending again.".into())}
    };
    if result.is_err() {
        let _ = state.close(&id);
    }
    result
}
#[tauri::command]
pub async fn desktop_crosspoint_read(
    window: WebviewWindow,
    state: State<'_, CrossPoint>,
    request: Handle,
) -> Result<Chunk, String> {
    main_window(&window)?;
    let transfer = state
        .transfers
        .lock()
        .map_err(|_| "Transfer state is unavailable.")?
        .get(&request.id)
        .cloned()
        .ok_or("The reader response has closed.")?;
    let cancelled = transfer.wake.notified();
    tokio::pin!(cancelled);
    cancelled.as_mut().enable();
    if transfer.cancelled.load(Ordering::Acquire) {
        return Err("The reader response was canceled.".into());
    }
    let read = async {
        let mut lock = transfer.body.lock().await;
        let body = lock.as_mut().ok_or("The reader response has not opened.")?;
        if body.offset >= body.pending.len() {
            match body
                .response
                .chunk()
                .await
                .map_err(|_| "The reader response was interrupted.")?
            {
                Some(bytes) => {
                    body.read = body
                        .read
                        .checked_add(bytes.len())
                        .ok_or("Reader response overflow.")?;
                    if body.read > body.limit {
                        return Err("The reader response exceeded the transfer limit.".to_owned());
                    }
                    body.pending = bytes.to_vec();
                    body.offset = 0;
                }
                None => {
                    return Ok(Chunk {
                        bytes: Vec::new(),
                        done: true,
                    })
                }
            }
        }
        let end = (body.offset + CHUNK).min(body.pending.len());
        let bytes = body.pending[body.offset..end].to_vec();
        body.offset = end;
        Ok(Chunk { bytes, done: false })
    };
    let result = tokio::select! {result=read=>result,_=cancelled=>Err("The reader response was canceled.".into())};
    if result.as_ref().map(|chunk| chunk.done).unwrap_or(true) {
        let _ = state.close(&request.id);
    }
    result
}
#[tauri::command]
pub fn desktop_crosspoint_close(
    window: WebviewWindow,
    state: State<'_, CrossPoint>,
    request: Handle,
) -> Result<(), String> {
    main_window(&window)?;
    state.close(&request.id)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_exact_crosspoint_routes_and_local_addresses() {
        assert!(route("http://192.168.1.2/api/status?plugin=avid", "GET").is_ok());
        assert!(route(
            "http://crosspoint.local/download?path=%2FBooks%2FA.epub",
            "GET"
        )
        .is_ok());
        for url in [
            "http://a/api/status?plugin=avid&plugin=x",
            "http://a/upload?path=/../x",
            "http://a/delete?path=/A.epub",
            "http://user:secret@a/api/status?plugin=avid",
            "file:///api/status?plugin=avid",
        ] {
            assert!(route(url, "GET").is_err());
        }
        for ip in [
            "127.0.0.1",
            "192.168.2.1",
            "10.0.0.2",
            "172.16.1.1",
            "169.254.1.2",
            "::1",
            "fc00::1",
            "fe80::1",
        ] {
            assert!(lan(ip.parse().unwrap()));
        }
        for ip in [
            "0.0.0.0",
            "8.8.8.8",
            "172.32.1.1",
            "224.0.0.1",
            "::",
            "2001:4860:4860::8888",
        ] {
            assert!(!lan(ip.parse().unwrap()));
        }
    }
    #[test]
    fn cancellation_before_open_and_repeated_ids_fail_closed() {
        let state = CrossPoint::default();
        let id = uuid::Uuid::new_v4().to_string();
        state.close(&id).unwrap();
        assert!(state.begin(&id).is_err());
        let id = uuid::Uuid::new_v4().to_string();
        let transfer = state.begin(&id).unwrap();
        assert!(state.begin(&id).is_err());
        state.close(&id).unwrap();
        assert!(transfer.cancelled.load(Ordering::Acquire));
    }
    #[test]
    fn loopback_fixture_strips_credentials_and_rejects_redirects() {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut input = [0u8; 4096];
            let count = socket.read(&mut input).unwrap();
            let headers = String::from_utf8_lossy(&input[..count]).to_lowercase();
            assert!(!headers.contains("authorization:"));
            assert!(!headers.contains("cookie:"));
            socket.write_all(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
        });
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let state = CrossPoint::default();
            let id = uuid::Uuid::new_v4().to_string();
            let transfer = state.begin(&id).unwrap();
            let result = send(
                Open {
                    id,
                    url: format!("http://{address}/api/status?plugin=avid"),
                    method: "GET".into(),
                    headers: vec![
                        ("Cookie".into(), "secret".into()),
                        ("Authorization".into(), "Bearer secret".into()),
                    ],
                    body_base64: None,
                },
                &transfer,
            )
            .await;
            assert!(matches!(result,Err(error) if error.contains("redirected")));
        });
        server.join().unwrap();
    }
}
