//! Session store: append-only JSONL ledger with a single-writer lock.
//!
//! Reliability is on the read side: [`project`] tolerantly skips unknown event
//! types (forward compat) and a truncated tail line left by a crash mid-append,
//! so the writer never has to guarantee whole-line atomicity. The `.lock` file
//! is held via `File::try_lock`; the kernel releases it when the process exits,
//! so a residual `.lock` file is harmless and never needs cleanup.

use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{self, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::event::{EventKind, LedgerEvent, SCHEMA};
use super::paths::sessions_dir;

const EVENTS_FILE: &str = "events.jsonl";
const META_FILE: &str = "meta.json";
const LOCK_FILE: &str = ".lock";

/// Per-session metadata snapshot written once at creation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Meta {
    pub schema: u32,
    pub id: String,
    pub created_at_ms: u128,
    pub workspace: String,
}

/// A live single-writer handle to one session's ledger.
///
/// Holds the advisory lock for its lifetime; drop releases it.
#[derive(Debug)]
pub struct SessionStore {
    id: String,
    dir: PathBuf,
    writer: File,
    _lock: File,
    seq: u64,
}

impl SessionStore {
    /// Create a fresh session under `root` and append `session.created`.
    pub fn create(root: &Path, workspace: &str) -> io::Result<Self> {
        let id = new_id();
        let dir = sessions_dir(root, &id);
        fs::create_dir_all(&dir)?;
        let lock = acquire_lock(&dir)?;
        let meta = Meta {
            schema: SCHEMA,
            id: id.clone(),
            created_at_ms: now_ms(),
            workspace: workspace.to_string(),
        };
        let meta_bytes = serde_json::to_vec_pretty(&meta).map_err(io::Error::other)?;
        fs::write(dir.join(META_FILE), meta_bytes)?;
        let writer = open_events(&dir)?;
        let mut store = SessionStore {
            id,
            dir,
            writer,
            _lock: lock,
            seq: 0,
        };
        store.append(
            None,
            EventKind::SessionCreated {
                workspace: workspace.to_string(),
            },
        )?;
        Ok(store)
    }

    /// Reopen an existing session for writing (resume).
    ///
    /// Fails with [`ErrorKind::WouldBlock`] if another writer holds the lock.
    pub fn open(dir: &Path) -> io::Result<Self> {
        let lock = acquire_lock(dir)?;
        let events = project(dir)?;
        let seq = events.iter().map(|event| event.seq).max().unwrap_or(0);
        let id = read_meta(dir).map(|meta| meta.id).unwrap_or_default();
        let writer = open_events(dir)?;
        Ok(SessionStore {
            id,
            dir: dir.to_path_buf(),
            writer,
            _lock: lock,
            seq,
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Append one event, stamping envelope fields, and flush the line.
    pub fn append(&mut self, turn_id: Option<String>, kind: EventKind) -> io::Result<LedgerEvent> {
        self.seq += 1;
        let event = LedgerEvent {
            schema: SCHEMA,
            event_id: new_id(),
            seq: self.seq,
            turn_id,
            kind,
        };
        let mut line = serde_json::to_string(&event).map_err(io::Error::other)?;
        line.push('\n');
        self.writer.write_all(line.as_bytes())?;
        self.writer.flush()?;
        Ok(event)
    }
}

fn open_events(dir: &Path) -> io::Result<File> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(EVENTS_FILE))
}

fn acquire_lock(dir: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(dir.join(LOCK_FILE))?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(TryLockError::WouldBlock) => Err(io::Error::new(
            ErrorKind::WouldBlock,
            "session already locked by another writer",
        )),
        Err(TryLockError::Error(err)) => Err(err),
    }
}

/// Replay a session's ledger, skipping unparseable lines (unknown type or a
/// truncated tail). Returns an empty vec if the file does not exist yet.
pub fn project(dir: &Path) -> io::Result<Vec<LedgerEvent>> {
    let content = match fs::read_to_string(dir.join(EVENTS_FILE)) {
        Ok(text) => text,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err),
    };
    let mut events = Vec::new();
    for line in content.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if let Ok(event) = serde_json::from_str::<LedgerEvent>(line) {
            events.push(event);
        }
    }
    Ok(events)
}

/// Read a session's `meta.json`.
pub fn read_meta(dir: &Path) -> io::Result<Meta> {
    let text = fs::read_to_string(dir.join(META_FILE))?;
    serde_json::from_str(&text).map_err(io::Error::other)
}

fn new_id() -> String {
    Uuid::new_v4().to_string()
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root() -> PathBuf {
        std::env::temp_dir().join(format!("pawwork-rs-test-{}", Uuid::new_v4()))
    }

    #[test]
    fn append_and_project_roundtrip() {
        let root = temp_root();
        let mut store = SessionStore::create(&root, "/tmp/ws").unwrap();
        let dir = store.dir().to_path_buf();
        store
            .append(
                None,
                EventKind::UserMessage {
                    text: "hi".to_string(),
                },
            )
            .unwrap();
        let events = project(&dir).unwrap();
        assert_eq!(events.len(), 2, "session.created + user.message");
        assert_eq!(events[0].seq, 1);
        assert_eq!(events[1].seq, 2);
        assert!(matches!(events[1].kind, EventKind::UserMessage { .. }));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn second_writer_is_rejected_until_released() {
        let root = temp_root();
        let store = SessionStore::create(&root, "ws").unwrap();
        let dir = store.dir().to_path_buf();
        let err = SessionStore::open(&dir).unwrap_err();
        assert_eq!(err.kind(), ErrorKind::WouldBlock);
        drop(store);
        let reopened = SessionStore::open(&dir).unwrap();
        assert_eq!(reopened.dir(), dir);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn resume_continues_seq() {
        let root = temp_root();
        let dir;
        {
            let mut store = SessionStore::create(&root, "ws").unwrap();
            dir = store.dir().to_path_buf();
            store
                .append(
                    None,
                    EventKind::UserMessage {
                        text: "one".to_string(),
                    },
                )
                .unwrap();
        }
        let mut store = SessionStore::open(&dir).unwrap();
        let event = store.append(None, EventKind::TurnCompleted).unwrap();
        assert_eq!(event.seq, 3, "created(1) + user(2) + completed(3)");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn project_skips_unknown_type_and_truncated_tail() {
        let root = temp_root();
        let dir;
        {
            let mut store = SessionStore::create(&root, "ws").unwrap();
            dir = store.dir().to_path_buf();
            store
                .append(
                    None,
                    EventKind::UserMessage {
                        text: "keep".to_string(),
                    },
                )
                .unwrap();
        }
        let mut file = OpenOptions::new()
            .append(true)
            .open(dir.join(EVENTS_FILE))
            .unwrap();
        writeln!(
            file,
            r#"{{"schema":1,"event_id":"x","seq":99,"turn_id":null,"type":"from_the_future","blob":true}}"#
        )
        .unwrap();
        write!(file, r#"{{"schema":1,"event_id":"y","seq":100,"typ"#).unwrap();
        drop(file);
        let events = project(&dir).unwrap();
        assert_eq!(
            events.len(),
            2,
            "unknown type and truncated tail are skipped"
        );
        fs::remove_dir_all(&root).ok();
    }
}
