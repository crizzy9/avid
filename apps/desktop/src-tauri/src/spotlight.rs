use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, io::Write, path::PathBuf, sync::Mutex, time::Instant};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Book {
    book_id: String,
    file_id: String,
    title: String,
    author: String,
    kind: String,
}
#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Saved {
    account_scope: Option<String>,
    books: BTreeMap<String, Book>,
}
struct IndexState {
    available: bool,
    active: Option<String>,
    saved: Saved,
    pending: Option<(String, Instant)>,
}
type Store = Mutex<IndexState>;
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum Request {
    Capabilities,
    Activate {
        #[serde(rename = "accountScope")]
        account_scope: String,
    },
    Index {
        #[serde(rename = "accountScope")]
        account_scope: String,
        books: Vec<Book>,
    },
    Remove {
        ids: Vec<String>,
    },
    Clear,
    Consume,
}
fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
fn identity(scope: &str, book: &Book) -> String {
    format!(
        "avid.book.{}",
        hash(&serde_json::to_string(&(scope, &book.book_id, &book.file_id, &book.kind)).unwrap())
    )
}
fn valid_text(value: &str, limit: usize, empty: bool) -> bool {
    (empty || !value.trim().is_empty())
        && value.len() <= limit
        && !value.chars().any(|c| c == '\0' || c.is_control())
}
fn valid_scope(scope: &str) -> bool {
    if scope.len() > 8192 {
        return false;
    }
    serde_json::from_str::<Vec<String>>(scope).is_ok_and(|parts| {
        parts.len() == 2 && parts.iter().all(|part| valid_text(part, 4096, false))
    })
}
fn valid_book(book: &Book) -> bool {
    valid_text(&book.book_id, 4096, false)
        && valid_text(&book.file_id, 4096, false)
        && valid_text(&book.title, 1024, false)
        && valid_text(&book.author, 1024, true)
        && ["epub", "pdf", "comic", "audio"].contains(&book.kind.as_str())
}
fn path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|value| value.join("spotlight.json"))
        .map_err(|error| error.to_string())
}
fn persist(app: &AppHandle, saved: &Saved) -> Result<(), String> {
    let path = path(app)?;
    fs::create_dir_all(path.parent().ok_or("Invalid Spotlight storage path.")?)
        .map_err(|error| error.to_string())?;
    let temporary = path.with_extension("tmp");
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    let bytes = serde_json::to_vec(saved).map_err(|error| error.to_string())?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err("The system search metadata limit was reached.".into());
    }
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| error.to_string())?;
    fs::rename(temporary, path).map_err(|error| error.to_string())
}
fn read(app: &AppHandle) -> Saved {
    let value = (|| {
        let path = path(app).ok()?;
        if fs::metadata(&path).ok()?.len() > 64 * 1024 * 1024 {
            return None;
        }
        let saved: Saved = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
        let scope = saved.account_scope.as_deref()?;
        if !valid_scope(scope)
            || saved.books.len() > 20000
            || saved
                .books
                .iter()
                .any(|(id, book)| !valid_book(book) || *id != identity(scope, book))
        {
            return None;
        }
        Some(saved)
    })();
    value.unwrap_or_default()
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use std::{
        ffi::{c_char, c_void, CStr, CString},
        sync::{mpsc, OnceLock},
    };
    static APP: OnceLock<AppHandle> = OnceLock::new();
    extern "C" {
        fn avid_spotlight_initialize(navigate: extern "C" fn(*const c_char)) -> bool;
        fn avid_spotlight_apply(
            json: *const c_char,
            context: *mut c_void,
            complete: extern "C" fn(*mut c_void, *const c_char),
        );
    }
    extern "C" fn navigate(pointer: *const c_char) {
        if pointer.is_null() {
            return;
        }
        let id = unsafe { CStr::from_ptr(pointer) }
            .to_string_lossy()
            .into_owned();
        let Some(app) = APP.get().cloned() else {
            return;
        };
        let received = Instant::now();
        // Spotlight can call this on the main thread during an index update.
        // Never wait for disk/index completion in the application delegate.
        tauri::async_runtime::spawn_blocking(move || {
            let Some(state) = app.try_state::<Store>() else {
                return;
            };
            if let Ok(mut state) = state.lock() {
                if !state.saved.books.contains_key(&id) {
                    return;
                }
                state.pending = Some((id, received));
            } else {
                return;
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            let _ = app.emit("avid:desktop-navigation", ());
        });
    }
    extern "C" fn complete(context: *mut c_void, error: *const c_char) {
        if context.is_null() {
            return;
        }
        let sender = unsafe { Box::from_raw(context as *mut mpsc::Sender<Result<(), String>>) };
        let result = if error.is_null() {
            Ok(())
        } else {
            Err(unsafe { CStr::from_ptr(error) }
                .to_string_lossy()
                .into_owned())
        };
        let _ = sender.send(result);
    }
    pub fn initialize(app: &AppHandle) -> bool {
        if APP.set(app.clone()).is_err() {
            return false;
        }
        unsafe { avid_spotlight_initialize(navigate) }
    }
    // Called only on a blocking worker while the index state is locked. Completion
    // is received before a new account's delete/index transaction can begin.
    pub fn apply(request: Value) -> Result<(), String> {
        let data = CString::new(request.to_string()).map_err(|_| "Invalid Spotlight request.")?;
        let (sender, receiver) = mpsc::channel::<Result<(), String>>();
        unsafe {
            avid_spotlight_apply(
                data.as_ptr(),
                Box::into_raw(Box::new(sender)) as *mut c_void,
                complete,
            )
        };
        receiver
            .recv()
            .map_err(|_| "Spotlight did not return a result.".to_string())?
    }
}
#[cfg(not(target_os = "macos"))]
mod native {
    use super::*;
    pub fn initialize(_: &AppHandle) -> bool {
        false
    }
    pub fn apply(_: Value) -> Result<(), String> {
        Ok(())
    }
}

pub fn initialize(app: &AppHandle) {
    let saved = read(app);
    app.manage(Mutex::new(IndexState {
        available: false,
        active: None,
        saved,
        pending: None,
    }));
    let available = native::initialize(app);
    if let Ok(mut state) = app.state::<Store>().lock() {
        state.available = available;
    }
}
fn clear_locked(app: &AppHandle, state: &mut IndexState) -> Result<(), String> {
    state.active = None;
    state.pending = None;
    native::apply(json!({"action":"clear"}))?;
    state.saved = Saved::default();
    persist(app, &state.saved)
}
fn consume_navigation(state: &mut IndexState) -> Value {
    let Some(scope) = state.active.as_ref() else {
        return json!({});
    };
    if state.saved.account_scope.as_ref() != Some(scope) {
        return json!({});
    }
    let result=state.pending.as_ref().filter(|(_,time)|time.elapsed().as_secs()<=300).and_then(|(id,_)|state.saved.books.get(id)).map(|book|json!({"book":{"scopeHash":hash(scope),"bookId":book.book_id,"fileId":book.file_id,"kind":book.kind}})).unwrap_or_else(||json!({}));
    state.pending = None;
    result
}
/** Logout must also call this, so OS results cannot outlive a cleared secure account. */
pub fn clear(app: &AppHandle) -> Result<(), String> {
    let store = app.state::<Store>();
    let mut state = store
        .lock()
        .map_err(|_| "System search storage is unavailable.")?;
    if !state.available {
        return Ok(());
    }
    clear_locked(app, &mut state)
}
fn process(app: &AppHandle, request: Request) -> Result<Value, String> {
    // Read credentials before taking the index lock; logout takes these locks in this order.
    let authenticated_scope = if matches!(request, Request::Capabilities | Request::Clear) {
        None
    } else {
        crate::desktop_io::active_account_scope(app)?
    };
    let store = app.state::<Store>();
    let mut state = store
        .lock()
        .map_err(|_| "System search storage is unavailable.")?;
    if matches!(request, Request::Capabilities) {
        return Ok(
            json!({"appGroupAvailable":false,"spotlightAvailable":state.available,"desktopSearchAvailable":state.available,"widgetExtensionEmbedded":false,"audioIntentsAvailable":false,"controlsAvailable":false}),
        );
    }
    if !state.available {
        return Ok(match request {
            Request::Index { .. } => json!({"ids":[]}),
            _ => json!({}),
        });
    }
    match request {
        Request::Activate { account_scope } => {
            if !valid_scope(&account_scope) || authenticated_scope.as_ref() != Some(&account_scope) {
                return Err("Invalid system search account.".into());
            }
            if state.saved.account_scope.as_ref() != Some(&account_scope) {
                clear_locked(app, &mut state)?;
                state.saved.account_scope = Some(account_scope.clone());
                persist(app, &state.saved)?;
            }
            state.active = Some(account_scope);
            Ok(json!({}))
        }
        Request::Index {
            account_scope,
            books,
        } => {
            if authenticated_scope.as_ref() != Some(&account_scope)
                || state.active.as_ref() != Some(&account_scope)
                || state.saved.account_scope.as_ref() != Some(&account_scope)
            {
                return Err("The system search account changed.".into());
            }
            if books.len() > 500 || books.iter().any(|book| !valid_book(book)) {
                return Err("Invalid system search metadata.".into());
            }
            let additions = books
                .iter()
                .filter(|book| {
                    !state
                        .saved
                        .books
                        .contains_key(&identity(&account_scope, book))
                })
                .count();
            if state.saved.books.len() + additions > 20000 {
                return Err("The system search metadata limit was reached.".into());
            }
            let items:Vec<_>=books.iter().map(|book|json!({"id":identity(&account_scope,book),"title":book.title,"author":book.author,"kind":book.kind})).collect();
            native::apply(
                json!({"action":"index","domain":format!("avid.{}",hash(&account_scope)),"items":items}),
            )?;
            let ids: Vec<_> = books
                .into_iter()
                .map(|book| {
                    let id = identity(&account_scope, &book);
                    state.saved.books.insert(id.clone(), book);
                    id
                })
                .collect();
            persist(app, &state.saved)?;
            Ok(json!({"ids":ids}))
        }
        Request::Remove { ids } => {
            if state.active.is_none() || state.active != authenticated_scope || state.active != state.saved.account_scope {
                return Err("No system search account is active.".into());
            }
            if ids.len() > 500 || ids.iter().any(|id| !state.saved.books.contains_key(id)) {
                return Err("Invalid system search identifiers.".into());
            }
            native::apply(json!({"action":"remove","ids":ids}))?;
            for id in ids {
                state.saved.books.remove(&id);
            }
            persist(app, &state.saved)?;
            Ok(json!({}))
        }
        Request::Clear => {
            clear_locked(app, &mut state)?;
            Ok(json!({}))
        }
        Request::Consume => {
            if state.active.is_none() || state.active != authenticated_scope {
                return Ok(json!({}));
            }
            Ok(consume_navigation(&mut state))
        },
        Request::Capabilities => unreachable!(),
    }
}
#[tauri::command]
pub async fn desktop_spotlight(
    window: WebviewWindow,
    app: AppHandle,
    request: Request,
) -> Result<Value, String> {
    super::surfaces::main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || process(&app, request))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn book() -> Book {
        Book {
            book_id: "1".into(),
            file_id: "2".into(),
            title: "Book".into(),
            author: "Author".into(),
            kind: "epub".into(),
        }
    }
    #[test]
    fn search_identifiers_are_bound_to_account_file_and_format() {
        let a = book();
        let mut b = book();
        b.file_id = "3".into();
        assert_ne!(identity("A", &a), identity("B", &a));
        assert_ne!(identity("A", &a), identity("A", &b));
        b.file_id = "2".into();
        b.kind = "pdf".into();
        assert_ne!(identity("A", &a), identity("A", &b));
        assert_eq!(identity("A", &a).len(), 74);
    }
    #[test]
    fn metadata_rejects_controls_and_invalid_formats() {
        let mut a = book();
        assert!(valid_book(&a));
        a.title = "bad\0title".into();
        assert!(!valid_book(&a));
        a = book();
        a.kind = "script".into();
        assert!(!valid_book(&a));
        assert!(valid_scope("[\"https://books.example\",\"12\"]"));
        assert!(!valid_scope("[]"));
    }
    #[test]
    fn cold_navigation_waits_for_matching_account_and_is_single_use() {
        let book = book();
        let id = identity("A", &book);
        let mut state = IndexState {
            available: true,
            active: None,
            saved: Saved {
                account_scope: Some("A".into()),
                books: BTreeMap::from([(id.clone(), book)]),
            },
            pending: Some((id, Instant::now())),
        };
        assert_eq!(consume_navigation(&mut state), json!({}));
        assert!(state.pending.is_some());
        state.active = Some("B".into());
        assert_eq!(consume_navigation(&mut state), json!({}));
        state.active = Some("A".into());
        assert_eq!(consume_navigation(&mut state)["book"]["fileId"], "2");
        assert_eq!(consume_navigation(&mut state), json!({}));
    }
    #[test]
    fn expired_or_removed_search_results_never_navigate() {
        let book = book();
        let id = identity("A", &book);
        let mut state = IndexState {
            available: true,
            active: Some("A".into()),
            saved: Saved {
                account_scope: Some("A".into()),
                books: BTreeMap::from([(id.clone(), book)]),
            },
            pending: Some((
                id.clone(),
                Instant::now() - std::time::Duration::from_secs(301),
            )),
        };
        assert_eq!(consume_navigation(&mut state), json!({}));
        assert!(state.pending.is_none());
        state.pending = Some((id, Instant::now()));
        state.saved.books.clear();
        assert_eq!(consume_navigation(&mut state), json!({}));
    }
}
