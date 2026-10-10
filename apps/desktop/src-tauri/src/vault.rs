//! Native-token sessions encrypted at rest; the OS credential store contains only the master key.
use aes_gcm::{
    aead::{rand_core::RngCore, Aead, OsRng, Payload},
    Aes256Gcm, KeyInit, Nonce,
};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fmt,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::Manager;
use uuid::Uuid;

const HEADER: &[u8] = b"AVIDVAULT\x01";
const AAD: &[u8] = b"app.avid.reader/session.vault/schema-1";
const NONCE_BYTES: usize = 12;
const TAG_BYTES: usize = 16;
pub const MAX_RECORD_BYTES: usize = 256 * 1024;
const MAX_FILE_BYTES: usize = HEADER.len() + NONCE_BYTES + MAX_RECORD_BYTES + TAG_BYTES;

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeSessionRecord {
    pub generation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read_only: Option<bool>,
}

// A debug representation must never make bearer/refresh credentials available to logs.
impl fmt::Debug for NativeSessionRecord {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NativeSessionRecord")
            .field("generation", &self.generation)
            .field("has_session", &self.session.is_some())
            .field("read_only", &self.read_only)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VaultError {
    KeychainUnavailable,
    MissingKey,
    InvalidKey,
    RandomUnavailable,
    StorageUnavailable,
    CorruptRecord,
    InvalidSession,
    StaleGeneration,
    DifferentAccount,
    LockUnavailable,
    InvalidAuxiliary,
}
impl fmt::Display for VaultError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::KeychainUnavailable => {
                "The operating system credential store is unavailable or locked."
            }
            Self::MissingKey => {
                "The encrypted session exists, but its operating system key is missing."
            }
            Self::InvalidKey => "The operating system session key is invalid.",
            Self::RandomUnavailable => "Secure random bytes are unavailable.",
            Self::StorageUnavailable => {
                "The private session file could not be read or durably saved."
            }
            Self::CorruptRecord => {
                "The encrypted session is damaged or could not be authenticated."
            }
            Self::InvalidSession => {
                "A valid native-token session and normalized server address are required."
            }
            Self::StaleGeneration => {
                "The secure session changed. This stale operation was discarded."
            }
            Self::DifferentAccount => "Clear the current session before changing accounts.",
            Self::LockUnavailable => "The secure session owner is unavailable.",
            Self::InvalidAuxiliary => "The secure sign-in transaction is invalid or too large.",
        })
    }
}
impl std::error::Error for VaultError {}

pub trait KeyProvider: Send {
    /// Only a definite absence returns None. Locked/unavailable/ambiguous stores return an error.
    fn load(&self) -> Result<Option<Vec<u8>>, VaultError>;
    fn save(&self, key: &[u8; 32]) -> Result<(), VaultError>;
}

pub struct OsKeyProvider;
impl OsKeyProvider {
    fn entry(&self) -> Result<keyring::Entry, VaultError> {
        keyring::Entry::new("app.avid.reader", "master-key")
            .map_err(|_| VaultError::KeychainUnavailable)
    }
}
impl KeyProvider for OsKeyProvider {
    fn load(&self) -> Result<Option<Vec<u8>>, VaultError> {
        match self.entry()?.get_secret() {
            Ok(key) => Ok(Some(key)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(VaultError::KeychainUnavailable),
        }
    }
    fn save(&self, key: &[u8; 32]) -> Result<(), VaultError> {
        self.entry()?
            .set_secret(key)
            .map_err(|_| VaultError::KeychainUnavailable)
    }
}

/// The auth owner holds this guard only for local reads/CAS commits, never during network awaits.
pub struct Vault {
    pub store: Mutex<VaultStore<OsKeyProvider>>,
}
impl Vault {
    /// Creating app state does not prompt/unlock the OS keychain or turn failure into an empty login.
    pub fn from_app(app: &tauri::AppHandle) -> Result<Self, VaultError> {
        let directory = app
            .path()
            .app_data_dir()
            .map_err(|_| VaultError::StorageUnavailable)?
            .join("private-session");
        Ok(Self {
            store: Mutex::new(VaultStore::new(directory, OsKeyProvider)),
        })
    }
    pub fn active_account_scope(&self) -> Result<Option<String>, VaultError> {
        let mut store = self.store.lock().map_err(|_| VaultError::LockUnavailable)?;
        let record = store.cached_record()?;
        record.session.as_ref().map(account_scope).transpose()
    }
}

pub struct VaultStore<P: KeyProvider> {
    directory: PathBuf,
    keys: P,
    cached: Option<NativeSessionRecord>,
    cached_prefix: Option<Vec<u8>>,
}
impl<P: KeyProvider> VaultStore<P> {
    pub fn new(directory: PathBuf, keys: P) -> Self {
        Self {
            directory,
            keys,
            cached: None,
            cached_prefix: None,
        }
    }
    fn path(&self) -> PathBuf {
        self.directory.join("session.vault")
    }

    pub fn read(&mut self) -> Result<NativeSessionRecord, VaultError> {
        self.cached = None;
        self.cached_prefix = None;
        let _lock = self.exclusive_lock()?;
        self.read_unlocked()
    }
    /// Streaming response checks avoid OS-keychain IPC while still detecting another process's
    /// rotation/logout through the freshly read random nonce. Only verified plaintext is cached.
    pub fn cached_record(&mut self) -> Result<NativeSessionRecord, VaultError> {
        let _lock = self.exclusive_lock()?;
        if let (Some(record), Some(prefix)) = (self.cached.as_ref(), self.cached_prefix.as_ref()) {
            let mut current = vec![0; HEADER.len() + NONCE_BYTES];
            if regular_file(&self.path())?
                && File::open(self.path())
                    .and_then(|mut file| file.read_exact(&mut current))
                    .is_ok()
                && &current == prefix
            {
                return Ok(record.clone());
            }
        }
        self.read_unlocked()
    }
    fn exclusive_lock(&self) -> Result<File, VaultError> {
        private_directory(&self.directory)?;
        let path = self.directory.join("session.lock");
        regular_file(&path)?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options
            .open(path)
            .map_err(|_| VaultError::StorageUnavailable)?;
        file.lock_exclusive()
            .map_err(|_| VaultError::LockUnavailable)?;
        Ok(file)
    }
    fn read_unlocked(&mut self) -> Result<NativeSessionRecord, VaultError> {
        // Explicit vault reads verify persisted data/key access again; lightweight account lookups
        // use Vault's successfully read cache. A failed read invalidates that cache too.
        self.cached = None;
        self.cached_prefix = None;
        private_directory(&self.directory)?;
        let exists = regular_file(&self.path())?;
        let auxiliary_exists = regular_file(&self.directory.join("oidc.vault"))?;
        let key = self.master_key(!exists && !auxiliary_exists)?;
        let record = if exists {
            let mut file = File::open(self.path()).map_err(|_| VaultError::StorageUnavailable)?;
            let length = file
                .metadata()
                .map_err(|_| VaultError::StorageUnavailable)?
                .len();
            if length < (HEADER.len() + NONCE_BYTES + TAG_BYTES) as u64
                || length > MAX_FILE_BYTES as u64
            {
                return Err(VaultError::CorruptRecord);
            }
            let mut bytes = Vec::with_capacity(length as usize);
            Read::by_ref(&mut file)
                .take(MAX_FILE_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| VaultError::StorageUnavailable)?;
            if bytes.len() != length as usize || !bytes.starts_with(HEADER) {
                return Err(VaultError::CorruptRecord);
            }
            let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| VaultError::InvalidKey)?;
            let nonce = Nonce::from_slice(&bytes[HEADER.len()..HEADER.len() + NONCE_BYTES]);
            let plaintext = cipher
                .decrypt(
                    nonce,
                    Payload {
                        msg: &bytes[HEADER.len() + NONCE_BYTES..],
                        aad: AAD,
                    },
                )
                .map_err(|_| VaultError::CorruptRecord)?;
            let record: NativeSessionRecord =
                serde_json::from_slice(&plaintext).map_err(|_| VaultError::CorruptRecord)?;
            validate_record(&record).map_err(|_| VaultError::CorruptRecord)?;
            self.cached_prefix = Some(bytes[..HEADER.len() + NONCE_BYTES].to_vec());
            record
        } else {
            let record = tombstone();
            self.persist(&record, &key)?;
            record
        };
        self.cached = Some(record.clone());
        Ok(record)
    }

    pub fn write(
        &mut self,
        expected_generation: &str,
        session: Value,
        read_only: bool,
    ) -> Result<NativeSessionRecord, VaultError> {
        validate_session(&session)?;
        let _lock = self.exclusive_lock()?;
        let previous = self.read_unlocked()?;
        if previous.generation != expected_generation {
            return Err(VaultError::StaleGeneration);
        }
        if let Some(prior) = previous.session.as_ref() {
            if account_scope(prior)? != account_scope(&session)? {
                return Err(VaultError::DifferentAccount);
            }
        }
        self.commit(NativeSessionRecord {
            generation: Uuid::new_v4().to_string(),
            session: Some(session),
            read_only: Some(read_only),
        })
    }
    pub fn clear(
        &mut self,
        expected_generation: Option<&str>,
    ) -> Result<NativeSessionRecord, VaultError> {
        let _lock = self.exclusive_lock()?;
        let previous = self.read_unlocked()?;
        if expected_generation.is_some_and(|expected| previous.generation != expected) {
            return Err(VaultError::StaleGeneration);
        }
        self.commit(tombstone())
    }
    fn commit(&mut self, record: NativeSessionRecord) -> Result<NativeSessionRecord, VaultError> {
        self.cached = None;
        self.cached_prefix = None;
        // A mutation must never replace a missing OS key. It is not a new vault initialization.
        let key = self.master_key(false)?;
        self.persist(&record, &key)?;
        self.cached = Some(record.clone());
        Ok(record)
    }
    /// Atomically consume/update the encrypted OIDC inbox together with a fresh session generation.
    /// The caller must validate expiry and generation; this operation never changes that generation.
    pub fn auxiliary_update<T>(
        &mut self,
        name: &str,
        action: impl FnOnce(
            &NativeSessionRecord,
            Option<Value>,
        ) -> Result<(Option<Value>, T), VaultError>,
    ) -> Result<T, VaultError> {
        const AUX_AAD: &[u8] = b"app.avid.reader/oidc.vault/schema-1";
        const AUX_LIMIT: usize = 64 * 1024;
        if name != "oidc" {
            return Err(VaultError::InvalidAuxiliary);
        }
        let _lock = self.exclusive_lock()?;
        let record = self.read_unlocked()?;
        let key = self.master_key(false)?;
        let path = self.directory.join("oidc.vault");
        let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| VaultError::InvalidKey)?;
        let previous = if regular_file(&path)? {
            let mut bytes = Vec::new();
            File::open(&path)
                .map_err(|_| VaultError::StorageUnavailable)?
                .take((HEADER.len() + NONCE_BYTES + TAG_BYTES + AUX_LIMIT + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|_| VaultError::StorageUnavailable)?;
            if bytes.len() < HEADER.len() + NONCE_BYTES + TAG_BYTES
                || bytes.len() > HEADER.len() + NONCE_BYTES + TAG_BYTES + AUX_LIMIT
                || !bytes.starts_with(HEADER)
            {
                return Err(VaultError::CorruptRecord);
            }
            let plaintext = cipher
                .decrypt(
                    Nonce::from_slice(&bytes[HEADER.len()..HEADER.len() + NONCE_BYTES]),
                    Payload {
                        msg: &bytes[HEADER.len() + NONCE_BYTES..],
                        aad: AUX_AAD,
                    },
                )
                .map_err(|_| VaultError::CorruptRecord)?;
            serde_json::from_slice::<Option<Value>>(&plaintext)
                .map_err(|_| VaultError::CorruptRecord)?
        } else {
            None
        };
        let (next, output) = action(&record, previous)?;
        let plaintext = serde_json::to_vec(&next).map_err(|_| VaultError::InvalidAuxiliary)?;
        if plaintext.len() > AUX_LIMIT {
            return Err(VaultError::InvalidAuxiliary);
        }
        let mut nonce = [0; NONCE_BYTES];
        OsRng
            .try_fill_bytes(&mut nonce)
            .map_err(|_| VaultError::RandomUnavailable)?;
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &plaintext,
                    aad: AUX_AAD,
                },
            )
            .map_err(|_| VaultError::CorruptRecord)?;
        let mut bytes = Vec::with_capacity(HEADER.len() + NONCE_BYTES + ciphertext.len());
        bytes.extend_from_slice(HEADER);
        bytes.extend_from_slice(&nonce);
        bytes.extend_from_slice(&ciphertext);
        // Even deletion writes an encrypted tombstone: consume is durable before exposing PKCE.
        atomic_write(&self.directory, &path, &bytes)?;
        Ok(output)
    }
    fn master_key(&self, can_create: bool) -> Result<[u8; 32], VaultError> {
        if let Some(key) = self.keys.load()? {
            return key.try_into().map_err(|_| VaultError::InvalidKey);
        }
        if !can_create {
            return Err(VaultError::MissingKey);
        }
        let mut key = [0u8; 32];
        OsRng
            .try_fill_bytes(&mut key)
            .map_err(|_| VaultError::RandomUnavailable)?;
        self.keys.save(&key)?;
        // Do not publish a session unless the OS store can immediately read back the same key.
        if self.keys.load()?.as_deref() != Some(key.as_slice()) {
            return Err(VaultError::InvalidKey);
        }
        Ok(key)
    }
    fn persist(&mut self, record: &NativeSessionRecord, key: &[u8; 32]) -> Result<(), VaultError> {
        validate_record(record)?;
        let plaintext = serde_json::to_vec(record).map_err(|_| VaultError::InvalidSession)?;
        if plaintext.len() > MAX_RECORD_BYTES {
            return Err(VaultError::InvalidSession);
        }
        let mut nonce = [0u8; NONCE_BYTES];
        OsRng
            .try_fill_bytes(&mut nonce)
            .map_err(|_| VaultError::RandomUnavailable)?;
        let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| VaultError::InvalidKey)?;
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &plaintext,
                    aad: AAD,
                },
            )
            .map_err(|_| VaultError::CorruptRecord)?;
        let mut bytes = Vec::with_capacity(HEADER.len() + nonce.len() + ciphertext.len());
        bytes.extend_from_slice(HEADER);
        bytes.extend_from_slice(&nonce);
        bytes.extend_from_slice(&ciphertext);
        atomic_write(&self.directory, &self.path(), &bytes)?;
        self.cached_prefix = Some(bytes[..HEADER.len() + NONCE_BYTES].to_vec());
        Ok(())
    }
}

fn tombstone() -> NativeSessionRecord {
    NativeSessionRecord {
        generation: Uuid::new_v4().to_string(),
        session: None,
        read_only: None,
    }
}
fn validate_record(record: &NativeSessionRecord) -> Result<(), VaultError> {
    if Uuid::parse_str(&record.generation).is_err() {
        return Err(VaultError::CorruptRecord);
    }
    if let Some(session) = record.session.as_ref() {
        validate_session(session)?;
    } else if record.read_only.is_some() {
        return Err(VaultError::CorruptRecord);
    }
    Ok(())
}
pub fn normalize_server_url(raw: &str) -> Result<String, VaultError> {
    if raw.len() > 8192 {
        return Err(VaultError::InvalidSession);
    }
    let parsed = url::Url::parse(raw.trim()).map_err(|_| VaultError::InvalidSession)?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(VaultError::InvalidSession);
    }
    let serialized = parsed.as_str().trim_end_matches('/');
    Ok(serialized
        .strip_suffix("/api/v1")
        .unwrap_or(serialized)
        .to_string())
}
pub fn account_scope(session: &Value) -> Result<String, VaultError> {
    let server = session
        .pointer("/profile/url")
        .and_then(Value::as_str)
        .ok_or(VaultError::InvalidSession)?;
    let user = required_string(session, "userId", 2048)?;
    serde_json::to_string(&[normalize_server_url(server)?, user.to_string()])
        .map_err(|_| VaultError::InvalidSession)
}
fn required_string<'a>(value: &'a Value, name: &str, max: usize) -> Result<&'a str, VaultError> {
    value
        .get(name)
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty() && s.len() <= max && !s.chars().any(char::is_control))
        .ok_or(VaultError::InvalidSession)
}
pub fn validate_session(session: &Value) -> Result<(), VaultError> {
    let fields = session.as_object().ok_or(VaultError::InvalidSession)?;
    if fields.keys().any(|key| {
        !matches!(
            key.as_str(),
            "profile" | "userId" | "accessToken" | "refreshToken" | "clientKind"
        )
    }) || session.get("clientKind").and_then(Value::as_str) != Some("native")
    {
        return Err(VaultError::InvalidSession);
    }
    required_string(session, "userId", 2048)?;
    required_string(session, "accessToken", MAX_RECORD_BYTES)?;
    required_string(session, "refreshToken", MAX_RECORD_BYTES)?;
    let profile = session.get("profile").ok_or(VaultError::InvalidSession)?;
    if !profile.is_object() {
        return Err(VaultError::InvalidSession);
    }
    required_string(profile, "id", 2048)?;
    required_string(profile, "name", 4096)?;
    let server = required_string(profile, "url", 8192)?;
    if normalize_server_url(server)? != server {
        return Err(VaultError::InvalidSession);
    }
    if serde_json::to_vec(session)
        .map_err(|_| VaultError::InvalidSession)?
        .len()
        > MAX_RECORD_BYTES
    {
        return Err(VaultError::InvalidSession);
    }
    Ok(())
}

fn private_directory(path: &Path) -> Result<(), VaultError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = fs::DirBuilder::new();
        builder.recursive(true).mode(0o700);
        builder
            .create(path)
            .map_err(|_| VaultError::StorageUnavailable)?;
    }
    #[cfg(not(unix))]
    fs::create_dir_all(path).map_err(|_| VaultError::StorageUnavailable)?;
    let metadata = fs::symlink_metadata(path).map_err(|_| VaultError::StorageUnavailable)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(VaultError::StorageUnavailable);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| VaultError::StorageUnavailable)?;
    }
    Ok(())
}
fn regular_file(path: &Path) -> Result<bool, VaultError> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(VaultError::StorageUnavailable),
        Ok(metadata) => {
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(VaultError::StorageUnavailable);
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(path, fs::Permissions::from_mode(0o600))
                    .map_err(|_| VaultError::StorageUnavailable)?;
            }
            Ok(true)
        }
    }
}
fn atomic_write(directory: &Path, target: &Path, bytes: &[u8]) -> Result<(), VaultError> {
    private_directory(directory)?;
    regular_file(target)?;
    let temporary = directory.join(format!("session.{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|_| VaultError::StorageUnavailable)?;
        file.write_all(bytes)
            .map_err(|_| VaultError::StorageUnavailable)?;
        file.sync_all()
            .map_err(|_| VaultError::StorageUnavailable)?;
        drop(file);
        replace_durably(&temporary, target)?;
        #[cfg(unix)]
        File::open(directory)
            .and_then(|parent| parent.sync_all())
            .map_err(|_| VaultError::StorageUnavailable)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
#[cfg(not(windows))]
fn replace_durably(source: &Path, target: &Path) -> Result<(), VaultError> {
    fs::rename(source, target).map_err(|_| VaultError::StorageUnavailable)
}
#[cfg(windows)]
fn replace_durably(source: &Path, target: &Path) -> Result<(), VaultError> {
    // Windows has no Unix directory-fsync equivalent. Request a write-through atomic replacement
    // after flushing the private temp file; never delete the old vault before the replacement.
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
    }
    let from: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    if from[..from.len() - 1].contains(&0) || to[..to.len() - 1].contains(&0) {
        return Err(VaultError::StorageUnavailable);
    }
    // SAFETY: both paths are NUL-terminated buffers kept alive for this synchronous call.
    let success = unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0x1 | 0x8) };
    if success == 0 {
        Err(VaultError::StorageUnavailable)
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    #[derive(Clone, Default)]
    struct MemoryKeys(Arc<Mutex<(Option<Vec<u8>>, bool)>>);
    impl KeyProvider for MemoryKeys {
        fn load(&self) -> Result<Option<Vec<u8>>, VaultError> {
            let state = self.0.lock().unwrap();
            if state.1 {
                Err(VaultError::KeychainUnavailable)
            } else {
                Ok(state.0.clone())
            }
        }
        fn save(&self, key: &[u8; 32]) -> Result<(), VaultError> {
            let mut state = self.0.lock().unwrap();
            if state.1 {
                return Err(VaultError::KeychainUnavailable);
            }
            state.0 = Some(key.to_vec());
            Ok(())
        }
    }
    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("avid-vault-test-{}", Uuid::new_v4())))
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn session(user: &str) -> Value {
        json!({"profile":{"id":"profile","name":"Library","url":"https://library.example"},"userId":user,
            "accessToken":"private-access-token", "refreshToken":"private-refresh-token", "clientKind":"native"})
    }
    #[test]
    fn auxiliary_consumption_is_durable_separate_and_authenticated() {
        let directory = Directory::new();
        let keys = MemoryKeys::default();
        let mut store = VaultStore::new(directory.0.clone(), keys.clone());
        let initial = store.read().unwrap();
        store
            .auxiliary_update("oidc", |record, previous| {
                assert_eq!(record.generation, initial.generation);
                assert!(previous.is_none());
                Ok((
                    Some(json!({"verifier":"secret-proof-key","generation":record.generation})),
                    (),
                ))
            })
            .unwrap();
        let bytes = fs::read(directory.0.join("oidc.vault")).unwrap();
        assert!(!String::from_utf8_lossy(&bytes).contains("secret-proof-key"));
        assert_eq!(store.read().unwrap(), initial);
        let mut reopened = VaultStore::new(directory.0.clone(), keys.clone());
        let taken = reopened
            .auxiliary_update("oidc", |_, previous| Ok((None, previous)))
            .unwrap();
        assert_eq!(taken.unwrap()["verifier"], "secret-proof-key");
        assert!(store
            .auxiliary_update("oidc", |_, previous| Ok((None, previous)))
            .unwrap()
            .is_none());
        assert_eq!(
            store.auxiliary_update("other", |_, value| Ok((value, ()))),
            Err(VaultError::InvalidAuxiliary)
        );
        assert_eq!(
            store.auxiliary_update("oidc", |_, _| Ok((Some(json!("x".repeat(64 * 1024))), ()))),
            Err(VaultError::InvalidAuxiliary)
        );
        // A valid session ciphertext cannot be moved to the OIDC namespace (different AAD).
        fs::copy(
            directory.0.join("session.vault"),
            directory.0.join("oidc.vault"),
        )
        .unwrap();
        assert_eq!(
            store.auxiliary_update("oidc", |_, value| Ok((value, ()))),
            Err(VaultError::CorruptRecord)
        );
    }
    #[test]
    fn first_read_is_a_durable_tombstone_and_sessions_reload_encrypted() {
        let directory = Directory::new();
        let keys = MemoryKeys::default();
        let mut store = VaultStore::new(directory.0.clone(), keys.clone());
        let initial = store.read().unwrap();
        assert!(initial.session.is_none());
        let mut reopened = VaultStore::new(directory.0.clone(), keys.clone());
        assert_eq!(initial, reopened.read().unwrap());
        let written = store
            .write(&initial.generation, session("1"), false)
            .unwrap();
        let bytes = fs::read(store.path()).unwrap();
        assert!(!bytes
            .windows(b"private-access-token".len())
            .any(|part| part == b"private-access-token"));
        assert_eq!(Some(32), keys.0.lock().unwrap().0.as_ref().map(Vec::len));
        assert_eq!(written, reopened.read().unwrap());
        assert!(!format!("{written:?}").contains("private-access-token"));
    }
    #[test]
    fn stale_refresh_cannot_undo_logout_and_clear_persists_its_generation() {
        let directory = Directory::new();
        let keys = MemoryKeys::default();
        let mut store = VaultStore::new(directory.0.clone(), keys.clone());
        let initial = store.read().unwrap();
        let login = store
            .write(&initial.generation, session("1"), true)
            .unwrap();
        let cleared = store.clear(Some(&login.generation)).unwrap();
        assert_ne!(login.generation, cleared.generation);
        assert_eq!(
            Err(VaultError::StaleGeneration),
            store.write(&login.generation, session("1"), false)
        );
        assert_eq!(
            Err(VaultError::StaleGeneration),
            store.clear(Some(&login.generation))
        );
        assert_eq!(
            cleared,
            VaultStore::new(directory.0.clone(), keys).read().unwrap()
        );
    }
    #[test]
    fn rotation_keeps_identity_and_switching_accounts_requires_clear() {
        let directory = Directory::new();
        let mut store = VaultStore::new(directory.0.clone(), MemoryKeys::default());
        let initial = store.read().unwrap();
        let login = store
            .write(&initial.generation, session("1"), true)
            .unwrap();
        let mut renewed = session("1");
        renewed["accessToken"] = json!("new-access");
        let rotation = store.write(&login.generation, renewed, true).unwrap();
        assert_ne!(login.generation, rotation.generation);
        assert_eq!(
            Err(VaultError::DifferentAccount),
            store.write(&rotation.generation, session("2"), false)
        );
        let mut other_server = session("1");
        other_server["profile"]["url"] = json!("https://another.example");
        assert_eq!(
            Err(VaultError::DifferentAccount),
            store.write(&rotation.generation, other_server, false)
        );
        let empty = store.clear(None).unwrap();
        assert!(store.write(&empty.generation, session("2"), false).is_ok());
    }
    #[test]
    fn missing_or_locked_key_never_creates_an_empty_replacement() {
        let directory = Directory::new();
        let keys = MemoryKeys::default();
        let mut store = VaultStore::new(directory.0.clone(), keys.clone());
        store.read().unwrap();
        let original = fs::read(store.path()).unwrap();
        keys.0.lock().unwrap().0 = None;
        assert_eq!(Err(VaultError::MissingKey), store.read());
        assert_eq!(original, fs::read(store.path()).unwrap());
        assert!(keys.0.lock().unwrap().0.is_none());
        keys.0.lock().unwrap().1 = true;
        assert_eq!(Err(VaultError::KeychainUnavailable), store.clear(None));
        let fresh = Directory::new();
        assert_eq!(
            Err(VaultError::KeychainUnavailable),
            VaultStore::new(fresh.0.clone(), keys).read()
        );
        assert!(!fresh.0.join("session.vault").exists());
    }
    #[test]
    fn ciphertext_header_nonce_and_key_tampering_fail_authentication() {
        let directory = Directory::new();
        let keys = MemoryKeys::default();
        let mut store = VaultStore::new(directory.0.clone(), keys.clone());
        store.read().unwrap();
        let original = fs::read(store.path()).unwrap();
        for index in [0, HEADER.len(), original.len() - 1] {
            let mut tampered = original.clone();
            tampered[index] ^= 0x80;
            fs::write(store.path(), tampered).unwrap();
            assert_eq!(Err(VaultError::CorruptRecord), store.read());
        }
        fs::write(store.path(), &original).unwrap();
        keys.0.lock().unwrap().0 = Some(vec![0; 32]);
        assert_eq!(Err(VaultError::CorruptRecord), store.read());
        keys.0.lock().unwrap().0 = Some(vec![0; 8]);
        assert_eq!(Err(VaultError::InvalidKey), store.read());
    }
    #[test]
    fn web_sessions_credentials_in_urls_and_oversized_records_are_rejected() {
        let directory = Directory::new();
        let mut store = VaultStore::new(directory.0.clone(), MemoryKeys::default());
        let initial = store.read().unwrap();
        let mut web = session("1");
        web["clientKind"] = json!("web");
        assert_eq!(
            Err(VaultError::InvalidSession),
            store.write(&initial.generation, web, false)
        );
        for server in [
            "https://name:password@example.com",
            "https://example.com/?query=1",
            "https://example.com/#secret",
            "file:///tmp/server",
            "https://library.example/",
        ] {
            let mut invalid = session("1");
            invalid["profile"]["url"] = json!(server);
            assert_eq!(
                Err(VaultError::InvalidSession),
                store.write(&initial.generation, invalid, false)
            );
        }
        let mut large = session("1");
        large["accessToken"] = json!("a".repeat(MAX_RECORD_BYTES));
        assert_eq!(
            Err(VaultError::InvalidSession),
            store.write(&initial.generation, large, false)
        );
        assert_eq!(initial, store.read().unwrap());
        assert_eq!(
            "https://example.com",
            normalize_server_url(" HTTPS://EXAMPLE.COM:443/api/v1/ ").unwrap()
        );
        assert_eq!(
            "[\"https://library.example\",\"1\"]",
            account_scope(&session("1")).unwrap()
        );
    }
    #[test]
    fn encrypted_record_nonces_change_and_tempfiles_never_hold_plaintext() {
        let directory = Directory::new();
        let mut store = VaultStore::new(directory.0.clone(), MemoryKeys::default());
        let initial = store.read().unwrap();
        let first = fs::read(store.path()).unwrap();
        let next = store.clear(Some(&initial.generation)).unwrap();
        let second = fs::read(store.path()).unwrap();
        assert_ne!(
            &first[HEADER.len()..HEADER.len() + NONCE_BYTES],
            &second[HEADER.len()..HEADER.len() + NONCE_BYTES]
        );
        assert_ne!(initial.generation, next.generation);
        assert!(!fs::read_dir(&directory.0).unwrap().any(|entry| entry
            .unwrap()
            .path()
            .extension()
            .is_some_and(|ext| ext == "tmp")));
    }
    #[test]
    fn separate_store_instances_serialize_cas_and_detect_cached_logout() {
        let directory = Directory::new();
        let keys = MemoryKeys::default();
        let mut first = VaultStore::new(directory.0.clone(), keys.clone());
        let initial = first.read().unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let workers: Vec<_> = (0..2)
            .map(|_| {
                let path = directory.0.clone();
                let keys = keys.clone();
                let barrier = barrier.clone();
                let generation = initial.generation.clone();
                std::thread::spawn(move || {
                    let mut store = VaultStore::new(path, keys);
                    barrier.wait();
                    store.write(&generation, session("1"), true)
                })
            })
            .collect();
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(1, results.iter().filter(|result| result.is_ok()).count());
        assert_eq!(
            1,
            results
                .iter()
                .filter(|result| matches!(result, Err(VaultError::StaleGeneration)))
                .count()
        );
        let login = first.cached_record().unwrap();
        assert!(login.session.is_some());
        keys.0.lock().unwrap().1 = true;
        assert_eq!(login, first.cached_record().unwrap()); // No repeated OS-keychain IPC per body chunk.
        keys.0.lock().unwrap().1 = false;
        let cleared = VaultStore::new(directory.0.clone(), keys)
            .clear(Some(&login.generation))
            .unwrap();
        assert_eq!(cleared, first.cached_record().unwrap());
    }
    #[cfg(unix)]
    #[test]
    fn unix_permissions_are_private_and_symlink_targets_are_rejected() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let directory = Directory::new();
        let mut store = VaultStore::new(directory.0.clone(), MemoryKeys::default());
        store.read().unwrap();
        assert_eq!(
            0o700,
            fs::metadata(&directory.0).unwrap().permissions().mode() & 0o777
        );
        assert_eq!(
            0o600,
            fs::metadata(store.path()).unwrap().permissions().mode() & 0o777
        );
        fs::remove_file(store.path()).unwrap();
        let outside = directory.0.join("outside");
        fs::write(&outside, b"do not change").unwrap();
        symlink(&outside, store.path()).unwrap();
        assert_eq!(Err(VaultError::StorageUnavailable), store.read());
        assert_eq!(b"do not change", fs::read(outside).unwrap().as_slice());
    }
}
