//! Scoped, revisioned library metadata. Credentials belong exclusively to the separate vault.
//! Binary files are immutable private receipts; no caller-supplied filesystem path is accepted.
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{
    params, types::Value as SqlValue, Connection, OptionalExtension, TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use uuid::Uuid;

const CHUNK_BYTES: usize = 256 * 1024;
const FILE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const TOTAL_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const STAGING_TTL_MS: i64 = 60 * 60 * 1000;
const MAX_ROW_BYTES: usize = 8 * 1024 * 1024;
const MAX_BATCH_BYTES: usize = 64 * 1024 * 1024;
const MAX_ROWS: usize = 100_000;
const STORAGE_ERROR: &str = "The private library store could not complete this operation.";
type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum Table {
    Books,
    Anchors,
    Annotations,
    Collections,
    Sessions,
    Preferences,
    Outbox,
    LocalFiles,
    NativeReceipts,
}
impl Table {
    fn name(self) -> &'static str {
        match self {
            Self::Books => "books",
            Self::Anchors => "anchors",
            Self::Annotations => "annotations",
            Self::Collections => "collections",
            Self::Sessions => "sessions",
            Self::Preferences => "preferences",
            Self::Outbox => "outbox",
            Self::LocalFiles => "localFiles",
            Self::NativeReceipts => "nativeReceipts",
        }
    }
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Query {
    ids: Option<Vec<String>>,
    entity_key: Option<String>,
    #[serde(default)]
    keys_only: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadRequest {
    scope: String,
    table: Table,
    #[serde(default)]
    query: Query,
}
#[derive(Serialize)]
pub struct ReadResponse {
    revision: String,
    rows: Vec<Value>,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Mutation {
    Put { table: Table, row: Value },
    Delete { table: Table, id: String },
    Clear { table: Table },
}
impl Mutation {
    fn table(&self) -> Table {
        match self {
            Self::Put { table, .. } | Self::Delete { table, .. } | Self::Clear { table } => *table,
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommitRequest {
    scope: String,
    expected: BTreeMap<Table, String>,
    mutations: Vec<Mutation>,
}
#[derive(Serialize)]
pub struct CommitResponse {
    committed: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BlobBegin {
    scope: String,
    size: u64,
    mime: String,
    name: String,
}
#[derive(Serialize)]
pub struct BlobId {
    id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BlobAppend {
    scope: String,
    id: String,
    offset: u64,
    data_base64: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BlobHandle {
    scope: String,
    id: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BlobReference {
    blob_id: String,
    size: u64,
    mime: String,
    name: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BlobRead {
    scope: String,
    blob_id: String,
    offset: u64,
    length: usize,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobBytes {
    data_base64: String,
    done: bool,
}

pub struct LibraryStorage(Mutex<Result<LibraryStore>>);
pub fn initialize(app: &AppHandle) {
    let store = app
        .path()
        .app_data_dir()
        .map_err(|_| STORAGE_ERROR.to_string())
        .and_then(|path| LibraryStore::open(path.join("private-library")));
    app.manage(LibraryStorage(Mutex::new(store)));
}
fn main_window(window: &WebviewWindow) -> Result<()> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Library storage requires Avid's main window.".into())
    }
}
fn with_store<T>(
    state: &LibraryStorage,
    action: impl FnOnce(&mut LibraryStore) -> Result<T>,
) -> Result<T> {
    let mut guard = state.0.lock().map_err(|_| STORAGE_ERROR.to_string())?;
    let store = guard.as_mut().map_err(|error| error.clone())?;
    action(store)
}
#[tauri::command]
pub fn library_storage_read(
    window: WebviewWindow,
    state: State<'_, LibraryStorage>,
    request: ReadRequest,
) -> Result<ReadResponse> {
    main_window(&window)?;
    with_store(&state, |store| store.read(request))
}
#[tauri::command]
pub fn library_storage_commit(
    window: WebviewWindow,
    state: State<'_, LibraryStorage>,
    request: CommitRequest,
) -> Result<CommitResponse> {
    main_window(&window)?;
    with_store(&state, |store| store.commit(request))
}
#[tauri::command]
pub fn library_storage_blob_begin(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, LibraryStorage>,
    request: BlobBegin,
) -> Result<BlobId> {
    main_window(&window)?;
    crate::desktop_io::with_storage_epoch(&app, |epoch| {
        with_store(&state, |store| store.begin_blob(request, epoch))
    })
}
#[tauri::command]
pub fn library_storage_blob_append(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, LibraryStorage>,
    request: BlobAppend,
) -> Result<()> {
    main_window(&window)?;
    crate::desktop_io::with_storage_epoch(&app, |epoch| {
        with_store(&state, |store| store.append_blob(request, epoch))
    })
}
#[tauri::command]
pub fn library_storage_blob_finish(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, LibraryStorage>,
    request: BlobHandle,
) -> Result<BlobReference> {
    main_window(&window)?;
    crate::desktop_io::with_storage_epoch(&app, |epoch| {
        with_store(&state, |store| store.finish_blob(request, epoch))
    })
}
#[tauri::command]
pub fn library_storage_blob_read(
    window: WebviewWindow,
    state: State<'_, LibraryStorage>,
    request: BlobRead,
) -> Result<BlobBytes> {
    main_window(&window)?;
    with_store(&state, |store| store.read_blob(request))
}
#[tauri::command]
pub fn library_storage_blob_cancel(
    window: WebviewWindow,
    state: State<'_, LibraryStorage>,
    request: BlobHandle,
) -> Result<()> {
    main_window(&window)?;
    with_store(&state, |store| store.cancel_blob(request))
}

struct LibraryStore {
    connection: Connection,
    directory: PathBuf,
    process_id: String,
}
impl LibraryStore {
    fn open(directory: PathBuf) -> Result<Self> {
        private_directory(&directory)?;
        private_directory(&directory.join("blobs"))?;
        let path = directory.join("library.sqlite3");
        for suffix in ["", "-wal", "-shm"] {
            regular_optional(&directory.join(format!("library.sqlite3{suffix}")))?;
        }
        // SQLite inherits the private database mode for WAL/SHM. Create it before opening.
        let mut options = private_options();
        options.read(true).write(true).create(true);
        options.open(&path).map_err(|_| STORAGE_ERROR)?;
        let mut connection = Connection::open(&path).map_err(sql_error)?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(sql_error)?;
        connection.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;").map_err(sql_error)?;
        let version: i64 = connection
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(sql_error)?;
        if version > 1 {
            return Err("This library store requires a newer Avid version.".into());
        }
        if version == 0 {
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(sql_error)?;
            tx.execute_batch("CREATE TABLE IF NOT EXISTS revisions(scope TEXT NOT NULL, table_name TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=0), PRIMARY KEY(scope,table_name));
                CREATE TABLE IF NOT EXISTS blobs(id TEXT PRIMARY KEY, scope TEXT NOT NULL, size INTEGER NOT NULL CHECK(size>=0), mime TEXT NOT NULL, name TEXT NOT NULL, state INTEGER NOT NULL CHECK(state IN(0,1)), offset INTEGER NOT NULL, created_at INTEGER NOT NULL, process_id TEXT NOT NULL, epoch INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS records(scope TEXT NOT NULL, table_name TEXT NOT NULL, id TEXT NOT NULL, row_key TEXT NOT NULL, json TEXT NOT NULL, entity_key TEXT, blob_id TEXT REFERENCES blobs(id), PRIMARY KEY(scope,table_name,id));
                CREATE INDEX IF NOT EXISTS record_entity ON records(scope,table_name,entity_key);
                CREATE INDEX IF NOT EXISTS record_blob ON records(blob_id);
                CREATE INDEX IF NOT EXISTS blob_scope ON blobs(scope);
                PRAGMA user_version=1;").map_err(sql_error)?;
            tx.commit().map_err(sql_error)?;
        }
        sync_directory(&directory)?;
        Ok(Self {
            connection,
            directory,
            process_id: Uuid::new_v4().to_string(),
        })
    }
    fn read(&mut self, request: ReadRequest) -> Result<ReadResponse> {
        validate_scope(&request.scope)?;
        if request.query.entity_key.is_some() && request.table != Table::Outbox {
            return Err("entityKey is only valid for outbox queries.".into());
        }
        if let Some(ids) = &request.query.ids {
            if ids.len() > 10_000 {
                return Err("Too many requested library rows.".into());
            }
            for id in ids {
                validate_id(id)?;
            }
        }
        let tx = self.connection.transaction().map_err(sql_error)?;
        let revision = revision(&tx, &request.scope, request.table)?;
        let mut rows = Vec::new();
        if request.query.ids.as_ref().is_some_and(Vec::is_empty) {
            return Ok(ReadResponse {
                revision: revision.to_string(),
                rows,
            });
        }
        let columns = if request.query.keys_only {
            "row_key,id"
        } else {
            "json,id"
        };
        let mut sql = format!("SELECT {columns} FROM records WHERE scope=? AND table_name=?");
        let mut values = vec![
            SqlValue::Text(request.scope.clone()),
            SqlValue::Text(request.table.name().into()),
        ];
        if let Some(key) = request.query.entity_key {
            sql.push_str(" AND entity_key=?");
            values.push(SqlValue::Text(key));
        }
        if let Some(ids) = request.query.ids {
            sql.push_str(" AND id IN (");
            sql.push_str(&vec!["?"; ids.len()].join(","));
            sql.push(')');
            values.extend(ids.into_iter().map(SqlValue::Text));
        }
        sql.push_str(" ORDER BY id");
        let mut stmt = tx.prepare(&sql).map_err(sql_error)?;
        let mut cursor = stmt
            .query(rusqlite::params_from_iter(values))
            .map_err(sql_error)?;
        let mut bytes = 0usize;
        while let Some(row) = cursor.next().map_err(sql_error)? {
            let content: String = row.get(0).map_err(sql_error)?;
            bytes = bytes.checked_add(content.len()).ok_or(STORAGE_ERROR)?;
            if bytes > MAX_BATCH_BYTES || rows.len() >= MAX_ROWS {
                return Err("The library snapshot is too large; request rows in batches.".into());
            }
            rows.push(if request.query.keys_only {
                let id: String = row.get(1).map_err(sql_error)?;
                json!({"key":content,"scope":request.scope,"id":id})
            } else {
                serde_json::from_str(&content)
                    .map_err(|_| "The library contains an invalid record.")?
            });
        }
        Ok(ReadResponse {
            revision: revision.to_string(),
            rows,
        })
    }
    fn commit(&mut self, request: CommitRequest) -> Result<CommitResponse> {
        validate_scope(&request.scope)?;
        if request.mutations.len() > MAX_ROWS {
            return Err("Too many library mutations.".into());
        }
        let mut changed = BTreeSet::new();
        let mut bytes = 0usize;
        for mutation in &request.mutations {
            let table = mutation.table();
            changed.insert(table);
            if !request.expected.contains_key(&table) {
                return Err("Every changed table requires an expected revision.".into());
            }
            if let Mutation::Put { row, .. } = mutation {
                let encoded = serde_json::to_vec(row).map_err(|_| STORAGE_ERROR)?;
                if encoded.len() > MAX_ROW_BYTES {
                    return Err("Library record is too large.".into());
                }
                bytes = bytes.checked_add(encoded.len()).ok_or(STORAGE_ERROR)?;
            }
        }
        if bytes > MAX_BATCH_BYTES {
            return Err("Library transaction is too large.".into());
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        for (table, expected) in &request.expected {
            let number = parse_revision(expected)?;
            if revision(&tx, &request.scope, *table)? != number {
                return Ok(CommitResponse { committed: false });
            }
        }
        for mutation in request.mutations {
            match mutation {
                Mutation::Put { table, row } => {
                    let id = validate_row(&request.scope, &row)?;
                    let blob_id = if table == Table::LocalFiles {
                        Some(validate_reference(
                            &tx,
                            &self.directory,
                            &request.scope,
                            &row,
                        )?)
                    } else {
                        None
                    };
                    let entity_key = if table == Table::Outbox {
                        row.get("entityKey").and_then(Value::as_str)
                    } else {
                        None
                    };
                    let encoded = serde_json::to_string(&row).map_err(|_| STORAGE_ERROR)?;
                    tx.execute("INSERT INTO records(scope,table_name,id,row_key,json,entity_key,blob_id) VALUES(?,?,?,?,?,?,?) ON CONFLICT(scope,table_name,id) DO UPDATE SET row_key=excluded.row_key,json=excluded.json,entity_key=excluded.entity_key,blob_id=excluded.blob_id",params![request.scope,table.name(),id,row["key"].as_str(),encoded,entity_key,blob_id]).map_err(sql_error)?;
                }
                Mutation::Delete { table, id } => {
                    validate_id(&id)?;
                    tx.execute(
                        "DELETE FROM records WHERE scope=? AND table_name=? AND id=?",
                        params![request.scope, table.name(), id],
                    )
                    .map_err(sql_error)?;
                }
                Mutation::Clear { table } => {
                    tx.execute(
                        "DELETE FROM records WHERE scope=? AND table_name=?",
                        params![request.scope, table.name()],
                    )
                    .map_err(sql_error)?;
                }
            }
        }
        for table in changed {
            let next = revision(&tx, &request.scope, table)?
                .checked_add(1)
                .ok_or("Library revision capacity exceeded.")?;
            tx.execute("INSERT INTO revisions(scope,table_name,revision) VALUES(?,?,?) ON CONFLICT(scope,table_name) DO UPDATE SET revision=excluded.revision",params![request.scope,table.name(),next]).map_err(sql_error)?;
        }
        tx.commit().map_err(sql_error)?;
        Ok(CommitResponse { committed: true })
    }
    fn begin_blob(&mut self, request: BlobBegin, epoch: u64) -> Result<BlobId> {
        validate_scope(&request.scope)?;
        validate_file_metadata(request.size, &request.mime, &request.name)?;
        self.cleanup()?;
        let epoch = i64::try_from(epoch).map_err(|_| STORAGE_ERROR)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        let (count, pending, bytes): (i64, i64, i64) = tx
            .query_row(
                "SELECT COUNT(*),COALESCE(SUM(state=0),0),COALESCE(SUM(size),0) FROM blobs",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(sql_error)?;
        if count >= 4096 || pending >= 4 || bytes as u64 + request.size > TOTAL_BYTES {
            return Err("Native file storage has reached its capacity.".into());
        }
        let id = Uuid::new_v4().to_string();
        let path = blob_path(&self.directory, &id, false);
        let mut options = private_options();
        options.write(true).create_new(true);
        let file = options.open(&path).map_err(|_| STORAGE_ERROR)?;
        file.sync_all().map_err(|_| STORAGE_ERROR)?;
        let result = (|| {
            tx.execute("INSERT INTO blobs(id,scope,size,mime,name,state,offset,created_at,process_id,epoch) VALUES(?,?,?,?,?,0,0,?,?,?)",params![id,request.scope,request.size as i64,request.mime,request.name,now_ms()?,self.process_id,epoch]).map_err(sql_error)?;
            tx.commit().map_err(sql_error)?;
            sync_directory(&self.directory.join("blobs"))?;
            Ok(BlobId { id: id.clone() })
        })();
        if result.is_err() {
            let _ = fs::remove_file(path);
        }
        result
    }
    fn append_blob(&mut self, request: BlobAppend, epoch: u64) -> Result<()> {
        validate_handle(&request.scope, &request.id)?;
        if request.data_base64.len() > CHUNK_BYTES.div_ceil(3) * 4 {
            return Err("Native file chunks must not exceed 256 KiB.".into());
        }
        let bytes = STANDARD
            .decode(&request.data_base64)
            .map_err(|_| "Invalid native file chunk encoding.")?;
        if bytes.is_empty() || bytes.len() > CHUNK_BYTES {
            return Err("Native file chunks must contain 1 to 256 KiB.".into());
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        let record = blob_record(&tx, &request.scope, &request.id)?;
        record.validate_pending(&self.process_id, epoch)?;
        if request.offset != record.offset
            || request
                .offset
                .checked_add(bytes.len() as u64)
                .is_none_or(|end| end > record.reference.size)
        {
            return Err("Native file chunks must be appended at the exact next offset.".into());
        }
        let path = blob_path(&self.directory, &request.id, false);
        require_file(&path, record.offset)?;
        let mut options = private_options();
        options.write(true);
        let mut file = options.open(&path).map_err(|_| STORAGE_ERROR)?;
        file.seek(SeekFrom::Start(record.offset))
            .map_err(|_| STORAGE_ERROR)?;
        // A failed write leaves a transfer unusable; it can only be cancelled/expired, never published.
        file.write_all(&bytes).map_err(|_| STORAGE_ERROR)?;
        file.sync_data().map_err(|_| STORAGE_ERROR)?;
        tx.execute(
            "UPDATE blobs SET offset=?,created_at=? WHERE id=?",
            params![
                (request.offset + bytes.len() as u64) as i64,
                now_ms()?,
                request.id
            ],
        )
        .map_err(sql_error)?;
        tx.commit().map_err(sql_error)
    }
    fn finish_blob(&mut self, request: BlobHandle, epoch: u64) -> Result<BlobReference> {
        validate_handle(&request.scope, &request.id)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        let record = blob_record(&tx, &request.scope, &request.id)?;
        // A lost IPC response may retry finish, but a later connection cannot adopt the handle.
        if record.state == 1 && record.process_id == self.process_id && record.epoch as u64 == epoch
        {
            require_file(
                &blob_path(&self.directory, &request.id, true),
                record.reference.size,
            )?;
            return Ok(record.reference);
        }
        record.validate_pending(&self.process_id, epoch)?;
        if record.offset != record.reference.size {
            return Err("The native file transfer is incomplete.".into());
        }
        let part = blob_path(&self.directory, &request.id, false);
        let destination = blob_path(&self.directory, &request.id, true);
        require_file(&part, record.reference.size)?;
        if regular_optional(&destination)? {
            return Err("The native file destination already exists.".into());
        }
        private_options()
            .write(true)
            .open(&part)
            .and_then(|file| file.sync_all())
            .map_err(|_| STORAGE_ERROR)?;
        rename_durably(&part, &destination)?;
        sync_directory(&self.directory.join("blobs"))?;
        tx.execute(
            "UPDATE blobs SET state=1,created_at=? WHERE id=?",
            params![now_ms()?, request.id],
        )
        .map_err(sql_error)?;
        tx.commit().map_err(sql_error)?;
        Ok(record.reference)
    }
    fn read_blob(&mut self, request: BlobRead) -> Result<BlobBytes> {
        validate_handle(&request.scope, &request.blob_id)?;
        if request.length > CHUNK_BYTES || request.length == 0 {
            return Err("Native file reads require 1 to 256 KiB.".into());
        }
        // Snapshot/read lock prevents TTL cleanup from removing an unreferenced migration receipt.
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        let record = blob_record(&tx, &request.scope, &request.blob_id)?;
        if record.state != 1 || request.offset > record.reference.size {
            return Err("Invalid native file receipt or read offset.".into());
        }
        let path = blob_path(&self.directory, &request.blob_id, true);
        require_file(&path, record.reference.size)?;
        let length = (record.reference.size - request.offset).min(request.length as u64) as usize;
        let mut bytes = vec![0; length];
        let mut file = File::open(path).map_err(|_| STORAGE_ERROR)?;
        file.seek(SeekFrom::Start(request.offset))
            .map_err(|_| STORAGE_ERROR)?;
        file.read_exact(&mut bytes).map_err(|_| STORAGE_ERROR)?;
        // Successful verification extends the grace period for long-running migrations.
        tx.execute(
            "UPDATE blobs SET created_at=? WHERE id=?",
            params![now_ms()?, request.blob_id],
        )
        .map_err(sql_error)?;
        tx.commit().map_err(sql_error)?;
        Ok(BlobBytes {
            data_base64: STANDARD.encode(bytes),
            done: request.offset + length as u64 == record.reference.size,
        })
    }
    fn cancel_blob(&mut self, request: BlobHandle) -> Result<()> {
        validate_handle(&request.scope, &request.id)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        // Published/finished receipts are immutable; cancellation never deletes them.
        let changed = tx
            .execute(
                "DELETE FROM blobs WHERE id=? AND scope=? AND state=0",
                params![request.id, request.scope],
            )
            .map_err(sql_error)?;
        tx.commit().map_err(sql_error)?;
        if changed > 0 {
            for finished in [false, true] {
                let path = blob_path(&self.directory, &request.id, finished);
                if regular_optional(&path)? {
                    fs::remove_file(path).map_err(|_| STORAGE_ERROR)?;
                }
            }
            sync_directory(&self.directory.join("blobs"))?;
        }
        Ok(())
    }
    fn cleanup(&mut self) -> Result<()> {
        let cutoff = now_ms()?.saturating_sub(STAGING_TTL_MS);
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(sql_error)?;
        let ids = {
            let mut stmt=tx.prepare("SELECT id FROM blobs WHERE created_at<? AND NOT EXISTS(SELECT 1 FROM records WHERE records.blob_id=blobs.id)").map_err(sql_error)?;
            let result = stmt
                .query_map([cutoff], |row| row.get::<_, String>(0))
                .map_err(sql_error)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(sql_error)?;
            result
        };
        for id in &ids {
            tx.execute("DELETE FROM blobs WHERE id=?", [id])
                .map_err(sql_error)?;
        }
        tx.commit().map_err(sql_error)?;
        for id in ids {
            for finished in [false, true] {
                let path = blob_path(&self.directory, &id, finished);
                if regular_optional(&path)? {
                    fs::remove_file(path).map_err(|_| STORAGE_ERROR)?;
                }
            }
        }
        // A crash between a rename/write and its SQL commit can leave only an opaque orphan.
        for entry in fs::read_dir(self.directory.join("blobs")).map_err(|_| STORAGE_ERROR)? {
            let entry = entry.map_err(|_| STORAGE_ERROR)?;
            let path = entry.path();
            let Some(stem) = path.file_stem().and_then(|name| name.to_str()) else {
                continue;
            };
            if Uuid::parse_str(stem).is_err()
                || !matches!(
                    path.extension().and_then(|s| s.to_str()),
                    Some("part" | "bin")
                )
            {
                continue;
            }
            let metadata = fs::symlink_metadata(&path).map_err(|_| STORAGE_ERROR)?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(STORAGE_ERROR.into());
            }
            let age = metadata
                .modified()
                .ok()
                .and_then(|time| SystemTime::now().duration_since(time).ok())
                .unwrap_or_default();
            if age.as_millis() < STAGING_TTL_MS as u128 {
                continue;
            }
            let exists: bool = self
                .connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM blobs WHERE id=?)",
                    [stem],
                    |row| row.get(0),
                )
                .map_err(sql_error)?;
            if !exists {
                fs::remove_file(path).map_err(|_| STORAGE_ERROR)?;
            }
        }
        Ok(())
    }
}

struct BlobRecord {
    reference: BlobReference,
    state: i64,
    offset: u64,
    created_at: i64,
    process_id: String,
    epoch: i64,
}
impl BlobRecord {
    fn validate_pending(&self, process: &str, epoch: u64) -> Result<()> {
        if self.state != 0
            || self.process_id != process
            || self.epoch as u64 != epoch
            || now_ms()?.saturating_sub(self.created_at) > STAGING_TTL_MS
        {
            return Err(
                "This native file transfer expired or belongs to an earlier connection.".into(),
            );
        }
        Ok(())
    }
}
fn blob_record(connection: &Connection, scope: &str, id: &str) -> Result<BlobRecord> {
    connection.query_row("SELECT size,mime,name,state,offset,created_at,process_id,epoch FROM blobs WHERE id=? AND scope=?",params![id,scope],|row|Ok(BlobRecord{reference:BlobReference{blob_id:id.into(),size:row.get::<_,i64>(0)? as u64,mime:row.get(1)?,name:row.get(2)?},state:row.get(3)?,offset:row.get::<_,i64>(4)? as u64,created_at:row.get(5)?,process_id:row.get(6)?,epoch:row.get(7)?})).optional().map_err(sql_error)?.ok_or_else(||"The native file receipt does not belong to this library.".into())
}
fn validate_reference(
    connection: &Connection,
    directory: &Path,
    scope: &str,
    row: &Value,
) -> Result<String> {
    let value = row
        .get("value")
        .and_then(Value::as_object)
        .ok_or("Invalid local file metadata.")?;
    if value.len() != 2 || !value.contains_key("name") || !value.contains_key("blob") {
        return Err("Local files require only a name and native blob receipt.".into());
    }
    let reference: BlobReference = serde_json::from_value(value["blob"].clone())
        .map_err(|_| "Invalid native blob reference.")?;
    validate_handle(scope, &reference.blob_id)?;
    let record = blob_record(connection, scope, &reference.blob_id)?;
    if record.state != 1
        || record.reference != reference
        || value["name"].as_str() != Some(reference.name.as_str())
    {
        return Err("Native file metadata does not match its immutable receipt.".into());
    }
    require_file(
        &blob_path(directory, &reference.blob_id, true),
        reference.size,
    )?;
    Ok(reference.blob_id)
}
fn revision(connection: &Connection, scope: &str, table: Table) -> Result<i64> {
    Ok(connection
        .query_row(
            "SELECT revision FROM revisions WHERE scope=? AND table_name=?",
            params![scope, table.name()],
            |row| row.get(0),
        )
        .optional()
        .map_err(sql_error)?
        .unwrap_or(0))
}
fn parse_revision(value: &str) -> Result<i64> {
    let number = value
        .parse::<i64>()
        .map_err(|_| "Invalid library revision.")?;
    if number < 0 || number.to_string() != value {
        return Err("Invalid library revision.".into());
    }
    Ok(number)
}
fn validate_scope(scope: &str) -> Result<()> {
    if scope.len() > 32 * 1024 {
        return Err("Invalid library account scope.".into());
    }
    let pair: Vec<String> =
        serde_json::from_str(scope).map_err(|_| "Invalid library account scope.")?;
    if pair.len() != 2
        || crate::vault::normalize_server_url(&pair[0])
            .map_err(|_| "Invalid library account scope.")?
            != pair[0]
        || serde_json::to_string(&pair).map_err(|_| STORAGE_ERROR)? != scope
    {
        return Err("Invalid library account scope.".into());
    }
    validate_id(&pair[1])
}
fn validate_id(id: &str) -> Result<()> {
    if id.trim().is_empty() || id.len() > 8192 || id.chars().any(char::is_control) {
        Err("Invalid library row identity.".into())
    } else {
        Ok(())
    }
}
fn validate_row<'a>(scope: &str, row: &'a Value) -> Result<&'a str> {
    let object = row.as_object().ok_or("Invalid library row.")?;
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .ok_or("Invalid library row identity.")?;
    validate_id(id)?;
    let key = serde_json::to_string(&[scope, id]).map_err(|_| STORAGE_ERROR)?;
    if object.get("scope").and_then(Value::as_str) != Some(scope)
        || object.get("key").and_then(Value::as_str) != Some(key.as_str())
    {
        return Err("Library rows must match their scoped identity.".into());
    }
    Ok(id)
}
fn validate_handle(scope: &str, id: &str) -> Result<()> {
    validate_scope(scope)?;
    if Uuid::parse_str(id).is_err() || id.to_lowercase() != id || id.len() != 36 {
        return Err("Invalid native file handle.".into());
    }
    Ok(())
}
fn validate_file_metadata(size: u64, mime: &str, name: &str) -> Result<()> {
    if size > FILE_BYTES
        || mime.len() > 1024
        || mime.chars().any(char::is_control)
        || name.len() > 4096
        || name.is_empty()
        || name.chars().any(char::is_control)
    {
        return Err("Invalid native file size or metadata.".into());
    }
    Ok(())
}
fn blob_path(directory: &Path, id: &str, finished: bool) -> PathBuf {
    directory
        .join("blobs")
        .join(format!("{id}.{}", if finished { "bin" } else { "part" }))
}
fn now_ms() -> Result<i64> {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| STORAGE_ERROR)?
            .as_millis(),
    )
    .map_err(|_| STORAGE_ERROR.into())
}
fn sql_error(_: rusqlite::Error) -> String {
    STORAGE_ERROR.into()
}
fn private_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
}
fn private_directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)
            .map_err(|_| STORAGE_ERROR)?;
    }
    #[cfg(not(unix))]
    fs::create_dir_all(path).map_err(|_| STORAGE_ERROR)?;
    let metadata = fs::symlink_metadata(path).map_err(|_| STORAGE_ERROR)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(STORAGE_ERROR.into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|_| STORAGE_ERROR)?;
    }
    Ok(())
}
fn regular_optional(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(STORAGE_ERROR.into()),
        Ok(metadata) => {
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(STORAGE_ERROR.into());
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(path, fs::Permissions::from_mode(0o600))
                    .map_err(|_| STORAGE_ERROR)?;
            }
            Ok(true)
        }
    }
}
fn require_file(path: &Path, size: u64) -> Result<()> {
    if !regular_optional(path)? || fs::metadata(path).map_err(|_| STORAGE_ERROR)?.len() != size {
        return Err("The native file is missing or incomplete.".into());
    }
    Ok(())
}
fn sync_directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|_| STORAGE_ERROR)?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
#[cfg(not(windows))]
fn rename_durably(source: &Path, target: &Path) -> Result<()> {
    fs::rename(source, target).map_err(|_| STORAGE_ERROR.into())
}
#[cfg(windows)]
fn rename_durably(source: &Path, target: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
    }
    let from: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    if from[..from.len() - 1].contains(&0) || to[..to.len() - 1].contains(&0) {
        return Err(STORAGE_ERROR.into());
    }
    // SAFETY: both UTF-16 paths stay alive and NUL-terminated through this synchronous call.
    // WRITE_THROUGH without REPLACE_EXISTING preserves immutable destination receipts.
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0x8) } == 0 {
        Err(STORAGE_ERROR.into())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("avid-library-test-{}", Uuid::new_v4())))
        }
        fn open(&self) -> LibraryStore {
            LibraryStore::open(self.0.clone()).unwrap()
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn scope(user: &str) -> String {
        serde_json::to_string(&["https://library.example", user]).unwrap()
    }
    fn row(scope: &str, id: &str, value: Value) -> Value {
        json!({"key":serde_json::to_string(&[scope,id]).unwrap(),"scope":scope,"id":id,"value":value})
    }
    fn put(scope: &str, table: Table, id: &str, value: Value) -> Mutation {
        Mutation::Put {
            table,
            row: row(scope, id, value),
        }
    }
    fn read(store: &mut LibraryStore, scope: &str, table: Table) -> ReadResponse {
        store
            .read(ReadRequest {
                scope: scope.into(),
                table,
                query: Query::default(),
            })
            .unwrap()
    }
    fn commit(
        store: &mut LibraryStore,
        scope: &str,
        expected: &[(Table, &str)],
        mutations: Vec<Mutation>,
    ) -> Result<CommitResponse> {
        store.commit(CommitRequest {
            scope: scope.into(),
            expected: expected.iter().map(|(t, r)| (*t, (*r).into())).collect(),
            mutations,
        })
    }
    fn begin(store: &mut LibraryStore, scope: &str, size: u64, epoch: u64) -> String {
        store
            .begin_blob(
                BlobBegin {
                    scope: scope.into(),
                    size,
                    mime: "audio/mpeg".into(),
                    name: "book.mp3".into(),
                },
                epoch,
            )
            .unwrap()
            .id
    }
    fn append(
        store: &mut LibraryStore,
        scope: &str,
        id: &str,
        offset: u64,
        bytes: &[u8],
        epoch: u64,
    ) -> Result<()> {
        store.append_blob(
            BlobAppend {
                scope: scope.into(),
                id: id.into(),
                offset,
                data_base64: STANDARD.encode(bytes),
            },
            epoch,
        )
    }
    fn finish(
        store: &mut LibraryStore,
        scope: &str,
        id: &str,
        epoch: u64,
    ) -> Result<BlobReference> {
        store.finish_blob(
            BlobHandle {
                scope: scope.into(),
                id: id.into(),
            },
            epoch,
        )
    }
    fn file_row(scope: &str, id: &str, reference: &BlobReference) -> Mutation {
        put(
            scope,
            Table::LocalFiles,
            id,
            json!({"name":reference.name,"blob":reference}),
        )
    }

    #[test]
    fn migration_is_durable_wal_full_and_unknown_schema_fails_closed() {
        let directory = Directory::new();
        {
            let store = directory.open();
            assert_eq!(
                store
                    .connection
                    .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                    .unwrap(),
                1
            );
            assert_eq!(
                store
                    .connection
                    .pragma_query_value(None, "journal_mode", |r| r.get::<_, String>(0))
                    .unwrap(),
                "wal"
            );
            assert_eq!(
                store
                    .connection
                    .pragma_query_value(None, "synchronous", |r| r.get::<_, i64>(0))
                    .unwrap(),
                2
            );
        }
        let mut store = directory.open();
        let s = scope("a");
        assert!(
            commit(
                &mut store,
                &s,
                &[(Table::Books, "0")],
                vec![put(&s, Table::Books, "book", json!({"title":"durable"}))]
            )
            .unwrap()
            .committed
        );
        drop(store);
        let mut reopened = directory.open();
        assert_eq!(
            read(&mut reopened, &s, Table::Books).rows[0]["value"]["title"],
            "durable"
        );
        reopened
            .connection
            .pragma_update(None, "user_version", 2)
            .unwrap();
        drop(reopened);
        assert!(LibraryStore::open(directory.0.clone()).is_err());
    }
    #[test]
    fn multi_table_cas_conflict_and_empty_validation_never_partially_apply() {
        let directory = Directory::new();
        let mut store = directory.open();
        let s = scope("a");
        commit(
            &mut store,
            &s,
            &[(Table::Books, "0")],
            vec![put(&s, Table::Books, "book", json!(1))],
        )
        .unwrap();
        assert!(
            !commit(
                &mut store,
                &s,
                &[(Table::Books, "0"), (Table::Anchors, "0")],
                vec![put(&s, Table::Anchors, "book", json!(2))]
            )
            .unwrap()
            .committed
        );
        assert!(read(&mut store, &s, Table::Anchors).rows.is_empty());
        assert!(
            !commit(&mut store, &s, &[(Table::Books, "0")], vec![])
                .unwrap()
                .committed
        );
        assert!(
            commit(
                &mut store,
                &s,
                &[(Table::Books, "1"), (Table::Anchors, "0")],
                vec![]
            )
            .unwrap()
            .committed
        );
        assert!(commit(
            &mut store,
            &s,
            &[],
            vec![put(&s, Table::Books, "other", json!(3))]
        )
        .is_err());
        assert_eq!(read(&mut store, &s, Table::Books).revision, "1");
    }
    #[test]
    fn ordered_mutations_clear_revisions_and_account_isolation_survive_reopen() {
        let directory = Directory::new();
        let mut store = directory.open();
        let a = scope("a");
        let b = scope("b");
        for s in [&a, &b] {
            commit(
                &mut store,
                s,
                &[(Table::Books, "0")],
                vec![put(s, Table::Books, "shared-id", json!(s))],
            )
            .unwrap();
        }
        commit(
            &mut store,
            &a,
            &[(Table::Books, "1")],
            vec![
                Mutation::Delete {
                    table: Table::Books,
                    id: "shared-id".into(),
                },
                put(&a, Table::Books, "shared-id", json!("replaced")),
            ],
        )
        .unwrap();
        assert_eq!(
            read(&mut store, &a, Table::Books).rows[0]["value"],
            "replaced"
        );
        commit(
            &mut store,
            &a,
            &[(Table::Books, "2")],
            vec![Mutation::Clear {
                table: Table::Books,
            }],
        )
        .unwrap();
        commit(
            &mut store,
            &a,
            &[(Table::Books, "3")],
            vec![Mutation::Clear {
                table: Table::Books,
            }],
        )
        .unwrap();
        drop(store);
        let mut reopened = directory.open();
        let result = read(&mut reopened, &a, Table::Books);
        assert!(result.rows.is_empty());
        assert_eq!(result.revision, "4");
        assert_eq!(read(&mut reopened, &b, Table::Books).rows.len(), 1);
    }
    #[test]
    fn invalid_second_row_and_sql_failure_roll_back_earlier_rows_and_revisions() {
        let directory = Directory::new();
        let mut store = directory.open();
        let s = scope("a");
        let mut forged = row(&s, "second", json!(2));
        forged["scope"] = json!(scope("other"));
        assert!(commit(
            &mut store,
            &s,
            &[(Table::Books, "0")],
            vec![
                put(&s, Table::Books, "first", json!(1)),
                Mutation::Put {
                    table: Table::Books,
                    row: forged
                }
            ]
        )
        .is_err());
        assert_eq!(read(&mut store, &s, Table::Books).revision, "0");
        assert!(read(&mut store, &s, Table::Books).rows.is_empty());
        store.connection.execute_batch("CREATE TRIGGER test_failure BEFORE INSERT ON records WHEN NEW.id='second' BEGIN SELECT RAISE(ABORT,'injected'); END;").unwrap();
        assert!(commit(
            &mut store,
            &s,
            &[(Table::Books, "0")],
            vec![
                put(&s, Table::Books, "first", json!(1)),
                put(&s, Table::Books, "second", json!(2))
            ]
        )
        .is_err());
        assert!(read(&mut store, &s, Table::Books).rows.is_empty());
        assert_eq!(read(&mut store, &s, Table::Books).revision, "0");
    }
    #[test]
    fn outbox_key_is_scope_and_id_while_entity_key_is_an_intersecting_filter() {
        let directory = Directory::new();
        let mut store = directory.open();
        let s = scope("a");
        let mut first = row(&s, "operation-1", json!({"type":"anchor"}));
        first["entityKey"] = json!("book");
        let mut second = row(&s, "operation-2", json!({"type":"anchor"}));
        second["entityKey"] = json!("other");
        commit(
            &mut store,
            &s,
            &[
                (Table::Outbox, "0"),
                (Table::Sessions, "0"),
                (Table::NativeReceipts, "0"),
            ],
            vec![
                Mutation::Put {
                    table: Table::Outbox,
                    row: first,
                },
                Mutation::Put {
                    table: Table::Outbox,
                    row: second,
                },
                put(&s, Table::Sessions, "session-id", json!({"duration":15})),
                put(
                    &s,
                    Table::NativeReceipts,
                    "receipt-id",
                    json!("fingerprint"),
                ),
            ],
        )
        .unwrap();
        let result = store
            .read(ReadRequest {
                scope: s.clone(),
                table: Table::Outbox,
                query: Query {
                    entity_key: Some("book".into()),
                    ids: Some(vec!["operation-1".into(), "operation-2".into()]),
                    keys_only: true,
                },
            })
            .unwrap();
        assert_eq!(
            result.rows,
            vec![
                json!({"key":serde_json::to_string(&[&s,"operation-1"]).unwrap(),"scope":s,"id":"operation-1"})
            ]
        );
        let empty = store
            .read(ReadRequest {
                scope: s.clone(),
                table: Table::Outbox,
                query: Query {
                    ids: Some(vec![]),
                    ..Query::default()
                },
            })
            .unwrap();
        assert!(empty.rows.is_empty());
        assert_eq!(empty.revision, "1");
        assert_eq!(
            read(&mut store, &s, Table::Sessions).rows[0]["id"],
            "session-id"
        );
        assert_eq!(
            read(&mut store, &s, Table::NativeReceipts).rows[0]["id"],
            "receipt-id"
        );
    }
    #[test]
    fn independent_connections_cannot_both_commit_the_same_revision() {
        let directory = Directory::new();
        let mut a = directory.open();
        let mut b = directory.open();
        let s = scope("a");
        assert_eq!(
            read(&mut a, &s, Table::Anchors).revision,
            read(&mut b, &s, Table::Anchors).revision
        );
        assert!(
            commit(
                &mut a,
                &s,
                &[(Table::Anchors, "0")],
                vec![put(&s, Table::Anchors, "book", json!(1))]
            )
            .unwrap()
            .committed
        );
        assert!(
            !commit(
                &mut b,
                &s,
                &[(Table::Anchors, "0")],
                vec![put(&s, Table::Anchors, "book", json!(2))]
            )
            .unwrap()
            .committed
        );
        assert_eq!(read(&mut b, &s, Table::Anchors).rows[0]["value"], 1);
    }
    #[test]
    fn binary_chunks_are_ordered_scoped_and_exact_reads_work_before_publication() {
        let directory = Directory::new();
        let mut store = directory.open();
        let s = scope("a");
        let id = begin(&mut store, &s, 6, 7);
        assert!(append(&mut store, &s, &id, 1, b"abc", 7).is_err());
        assert!(append(&mut store, &scope("b"), &id, 0, b"abc", 7).is_err());
        append(&mut store, &s, &id, 0, b"abc", 7).unwrap();
        assert!(finish(&mut store, &s, &id, 7).is_err());
        assert!(append(&mut store, &s, &id, 0, b"abc", 7).is_err());
        append(&mut store, &s, &id, 3, b"def", 7).unwrap();
        let reference = finish(&mut store, &s, &id, 7).unwrap();
        assert_eq!(reference.size, 6);
        assert!(append(&mut store, &s, &id, 6, b"x", 7).is_err());
        let first = store
            .read_blob(BlobRead {
                scope: s.clone(),
                blob_id: id.clone(),
                offset: 0,
                length: 2,
            })
            .unwrap();
        assert_eq!(STANDARD.decode(first.data_base64).unwrap(), b"ab");
        assert!(!first.done);
        let end = store
            .read_blob(BlobRead {
                scope: s.clone(),
                blob_id: id.clone(),
                offset: 2,
                length: CHUNK_BYTES,
            })
            .unwrap();
        assert_eq!(STANDARD.decode(end.data_base64).unwrap(), b"cdef");
        assert!(end.done);
        let eof = store
            .read_blob(BlobRead {
                scope: s.clone(),
                blob_id: id.clone(),
                offset: 6,
                length: 1,
            })
            .unwrap();
        assert!(eof.data_base64.is_empty());
        assert!(eof.done);
        assert!(store
            .read_blob(BlobRead {
                scope: scope("b"),
                blob_id: id.clone(),
                offset: 0,
                length: 1
            })
            .is_err());
        commit(
            &mut store,
            &s,
            &[(Table::LocalFiles, "0")],
            vec![file_row(&s, "file", &reference)],
        )
        .unwrap();
        drop(store);
        let mut reopened = directory.open();
        let result = reopened
            .read_blob(BlobRead {
                scope: s.clone(),
                blob_id: id,
                offset: 0,
                length: 6,
            })
            .unwrap();
        assert_eq!(STANDARD.decode(result.data_base64).unwrap(), b"abcdef");
        assert_eq!(
            read(&mut reopened, &s, Table::LocalFiles).rows[0]["value"]["blob"]["size"],
            6
        );
    }
    #[test]
    fn zero_byte_files_finish_and_reference_metadata_cannot_be_forged() {
        let directory = Directory::new();
        let mut store = directory.open();
        let s = scope("a");
        let id = begin(&mut store, &s, 0, 0);
        let reference = finish(&mut store, &s, &id, 0).unwrap();
        let mut forged = reference.clone();
        forged.size = 1;
        assert!(commit(
            &mut store,
            &s,
            &[(Table::Books, "0"), (Table::LocalFiles, "0")],
            vec![
                put(&s, Table::Books, "book", json!(1)),
                file_row(&s, "file", &forged)
            ]
        )
        .is_err());
        assert!(read(&mut store, &s, Table::Books).rows.is_empty());
        assert!(commit(
            &mut store,
            &scope("b"),
            &[(Table::LocalFiles, "0")],
            vec![file_row(&scope("b"), "file", &reference)]
        )
        .is_err());
        commit(
            &mut store,
            &s,
            &[(Table::LocalFiles, "0")],
            vec![file_row(&s, "file", &reference)],
        )
        .unwrap();
        store
            .cancel_blob(BlobHandle {
                scope: s.clone(),
                id: id.clone(),
            })
            .unwrap();
        assert!(blob_path(&directory.0, &id, true).exists());
        fs::remove_file(blob_path(&directory.0, &id, true)).unwrap();
        let keys = store
            .read(ReadRequest {
                scope: s.clone(),
                table: Table::LocalFiles,
                query: Query {
                    keys_only: true,
                    ..Query::default()
                },
            })
            .unwrap();
        assert_eq!(keys.rows.len(), 1);
        assert!(keys.rows[0].get("value").is_none());
        assert!(store
            .read_blob(BlobRead {
                scope: s,
                blob_id: id,
                offset: 0,
                length: 1
            })
            .is_err());
    }
    #[test]
    fn transfers_reject_new_connection_epochs_and_restarted_handles() {
        let directory = Directory::new();
        let mut store = directory.open();
        let s = scope("a");
        let id = begin(&mut store, &s, 1, 3);
        assert!(append(&mut store, &s, &id, 0, b"x", 4).is_err());
        append(&mut store, &s, &id, 0, b"x", 3).unwrap();
        assert!(finish(&mut store, &s, &id, 4).is_err());
        drop(store);
        let mut reopened = directory.open();
        assert!(finish(&mut reopened, &s, &id, 3).is_err());
        reopened.cancel_blob(BlobHandle { scope: s, id }).unwrap();
    }
    #[test]
    fn four_gibibyte_sparse_files_use_bounded_reads_and_finish_retries_are_stable() {
        let directory = Directory::new();
        let mut store = directory.open();
        let s = scope("large");
        let id = begin(&mut store, &s, FILE_BYTES, 1);
        // A sparse fixture exercises 64-bit offsets without allocating a book-sized buffer.
        private_options()
            .write(true)
            .open(blob_path(&directory.0, &id, false))
            .unwrap()
            .set_len(FILE_BYTES)
            .unwrap();
        store
            .connection
            .execute(
                "UPDATE blobs SET offset=? WHERE id=?",
                params![FILE_BYTES as i64, id],
            )
            .unwrap();
        let reference = finish(&mut store, &s, &id, 1).unwrap();
        assert_eq!(finish(&mut store, &s, &id, 1).unwrap(), reference);
        assert!(finish(&mut store, &s, &id, 2).is_err());
        let first = store
            .read_blob(BlobRead {
                scope: s.clone(),
                blob_id: id.clone(),
                offset: 0,
                length: 1,
            })
            .unwrap();
        assert_eq!(STANDARD.decode(first.data_base64).unwrap(), [0]);
        assert!(!first.done);
        let last = store
            .read_blob(BlobRead {
                scope: s,
                blob_id: id,
                offset: FILE_BYTES - 2,
                length: CHUNK_BYTES,
            })
            .unwrap();
        assert_eq!(STANDARD.decode(last.data_base64).unwrap(), [0, 0]);
        assert!(last.done);
    }
    #[test]
    fn expired_unreferenced_files_free_capacity_but_published_files_survive() {
        let directory = Directory::new();
        let mut store = directory.open();
        let s = scope("a");
        let published = begin(&mut store, &s, 0, 0);
        let reference = finish(&mut store, &s, &published, 0).unwrap();
        commit(
            &mut store,
            &s,
            &[(Table::LocalFiles, "0")],
            vec![file_row(&s, "file", &reference)],
        )
        .unwrap();
        let unused = begin(&mut store, &s, 0, 0);
        finish(&mut store, &s, &unused, 0).unwrap();
        for _ in 0..4 {
            begin(&mut store, &s, 0, 0);
        }
        assert!(store
            .begin_blob(
                BlobBegin {
                    scope: s.clone(),
                    size: 0,
                    mime: "".into(),
                    name: "a".into()
                },
                0
            )
            .is_err());
        store
            .connection
            .execute("UPDATE blobs SET created_at=0", [])
            .unwrap();
        let next = begin(&mut store, &s, 0, 0);
        assert!(blob_path(&directory.0, &published, true).exists());
        assert!(!blob_path(&directory.0, &unused, true).exists());
        assert!(blob_path(&directory.0, &next, false).exists());
    }
    #[test]
    fn quota_chunk_and_scope_validation_reject_invalid_inputs() {
        let directory = Directory::new();
        let mut store = directory.open();
        let s = scope("a");
        let one = begin(&mut store, &s, FILE_BYTES, 0);
        let two = begin(&mut store, &s, FILE_BYTES, 0);
        assert!(store
            .begin_blob(
                BlobBegin {
                    scope: s.clone(),
                    size: 1,
                    mime: "".into(),
                    name: "a".into()
                },
                0
            )
            .is_err());
        store
            .cancel_blob(BlobHandle {
                scope: s.clone(),
                id: two,
            })
            .unwrap();
        assert!(append(&mut store, &s, &one, 0, &vec![0; CHUNK_BYTES + 1], 0).is_err());
        for bad in [
            "[]",
            "[\"file:///tmp\",\"user\"]",
            "[\"https://library.example/\",\"user\"]",
            "[\"https://user:password@library.example\",\"user\"]",
            "[ \"https://library.example\", \"user\" ]",
        ] {
            assert!(validate_scope(bad).is_err());
        }
        validate_scope("[\"https://demo.avid.invalid\",\"demo\"]").unwrap();
        assert!(
            serde_json::from_value::<ReadRequest>(json!({"scope":s,"table":"arbitrary"})).is_err()
        );
        assert!(store
            .read_blob(BlobRead {
                scope: s,
                blob_id: "../../other".into(),
                offset: 0,
                length: 1
            })
            .is_err());
    }
    #[cfg(unix)]
    #[test]
    fn database_and_blob_permissions_are_private_and_symlinks_are_rejected() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let directory = Directory::new();
        let mut store = directory.open();
        let s = scope("a");
        let id = begin(&mut store, &s, 0, 0);
        assert_eq!(
            fs::metadata(&directory.0).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(directory.0.join("library.sqlite3"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        let path = blob_path(&directory.0, &id, false);
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::remove_file(&path).unwrap();
        symlink(directory.0.join("library.sqlite3"), &path).unwrap();
        assert!(finish(&mut store, &s, &id, 0).is_err());
    }
}
