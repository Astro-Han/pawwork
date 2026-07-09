//! Session store: append-only JSONL ledger with a single-writer lock.
//!
//! Durability boundary: process-crash safe, not power-loss safe. `append`
//! flushes to the OS but does not `fsync`, so a returned event survives a
//! process crash or kill, while an OS crash or power loss may still lose the
//! most recent unsynced writes. Per-append fsync is deferred until a tool with
//! real side effects needs it (later PR); the wording here stays "crash-safe",
//! not "durable", on purpose.
//!
//! Crash-torn tail: a crash mid-append can leave a final line without its
//! trailing newline. [`SessionStore::open`] truncates that torn tail back to
//! the last clean record boundary before appending, so a resumed writer never
//! concatenates a new record onto half of an old one.
//!
//! Tolerance is deliberately narrow — [`scan`] accepts exactly two things and
//! errors on everything else: a torn (newline-less) tail line, dropped and
//! truncated on resume; and a complete line whose payload this version cannot
//! parse but whose envelope (`schema`/`seq`/`type`) is valid (forward-compat,
//! not projected but still counted for `seq`).
//!
//! A complete line without a valid envelope is real corruption and surfaces as
//! an error rather than being silently skipped. The `.lock` file is held via
//! `File::try_lock`; the kernel releases it on exit, so a residual `.lock` is
//! harmless.

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

/// Minimal envelope used to recognize a structurally valid ledger line whose
/// payload this version cannot fully parse (a forward-compatible future event).
/// Requiring `schema`/`seq`/`type` is the bar for "valid envelope"; a complete
/// line that fails even this is treated as corruption.
#[derive(Deserialize)]
struct RawEnvelope {
    #[allow(dead_code)]
    schema: u32,
    seq: u64,
    #[allow(dead_code)]
    #[serde(rename = "type")]
    kind: String,
}

/// Result of one ledger scan: the projected events, the highest `seq` seen
/// across all complete records (including forward-compat ones that were not
/// projected), and the byte length of the clean, newline-terminated region.
struct Scan {
    events: Vec<LedgerEvent>,
    max_seq: u64,
    complete_len: u64,
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
    /// Fails with [`ErrorKind::WouldBlock`] if another writer holds the lock,
    /// and with an error if the ledger has a corrupt complete line. Truncates a
    /// crash-torn tail line before continuing so appends resume on a clean
    /// record boundary. `seq` continues from the highest record seen, including
    /// forward-compat records that this version could not project.
    pub fn open(dir: &Path) -> io::Result<Self> {
        let lock = acquire_lock(dir)?;
        let scan = scan(dir)?;
        let events_path = dir.join(EVENTS_FILE);
        if let Ok(meta) = fs::metadata(&events_path) {
            if meta.len() > scan.complete_len {
                let file = OpenOptions::new().write(true).open(&events_path)?;
                file.set_len(scan.complete_len)?;
            }
        }
        let id = read_meta(dir).map(|meta| meta.id).unwrap_or_default();
        let writer = open_events(dir)?;
        Ok(SessionStore {
            id,
            dir: dir.to_path_buf(),
            writer,
            _lock: lock,
            seq: scan.max_seq,
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Append one event, stamping envelope fields, and flush to the OS.
    ///
    /// Flush is not fsync; see the module-level durability note.
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

/// Scan the ledger once: project parseable events, advance `seq` across every
/// complete record, and report the clean (newline-terminated) byte length so a
/// caller can truncate a crash-torn tail. Errors on a corrupt complete line;
/// tolerates only a torn tail and forward-compat future records.
fn scan(dir: &Path) -> io::Result<Scan> {
    let bytes = match fs::read(dir.join(EVENTS_FILE)) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == ErrorKind::NotFound => {
            return Ok(Scan {
                events: Vec::new(),
                max_seq: 0,
                complete_len: 0,
            });
        }
        Err(err) => return Err(err),
    };
    // The complete region ends at the last newline; anything after it is an
    // unterminated tail line left by a crash mid-append.
    let complete_len = match bytes.iter().rposition(|&byte| byte == b'\n') {
        Some(index) => index + 1,
        None => 0,
    };
    let complete = std::str::from_utf8(&bytes[..complete_len]).map_err(io::Error::other)?;
    let mut events = Vec::new();
    let mut max_seq = 0u64;
    for line in complete.lines() {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<LedgerEvent>(line) {
            Ok(event) => {
                max_seq = max_seq.max(event.seq);
                events.push(event);
            }
            Err(_) => match serde_json::from_str::<RawEnvelope>(line) {
                // Valid envelope, unparseable payload: a future/forward-compat
                // record. Count its seq so a resumed writer does not collide,
                // but do not project it.
                Ok(envelope) => max_seq = max_seq.max(envelope.seq),
                // A complete line that is not even a valid envelope is real
                // corruption; surface it instead of silently dropping events.
                Err(err) => return Err(io::Error::other(format!("corrupt ledger line: {err}"))),
            },
        }
    }
    Ok(Scan {
        events,
        max_seq,
        complete_len: complete_len as u64,
    })
}

/// Replay a session's ledger into its projected events.
///
/// Errors on a corrupt complete line; tolerates a crash-torn tail line and
/// forward-compat future records (which are not projected). Returns an empty
/// vec if the file does not exist yet.
pub fn project(dir: &Path) -> io::Result<Vec<LedgerEvent>> {
    Ok(scan(dir)?.events)
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

    fn append_raw(dir: &Path, line: &str, terminate: bool) {
        let mut file = OpenOptions::new()
            .append(true)
            .open(dir.join(EVENTS_FILE))
            .unwrap();
        file.write_all(line.as_bytes()).unwrap();
        if terminate {
            file.write_all(b"\n").unwrap();
        }
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
    fn project_tolerates_unknown_type_and_torn_tail() {
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
        // Complete line, unknown type (valid envelope) — forward-compat, skipped.
        append_raw(
            &dir,
            r#"{"schema":1,"event_id":"x","seq":99,"turn_id":null,"type":"from_the_future","blob":true}"#,
            true,
        );
        // Torn tail line (no newline) — dropped.
        append_raw(&dir, r#"{"schema":1,"event_id":"y","seq":100,"typ"#, false);
        let events = project(&dir).unwrap();
        assert_eq!(
            events.len(),
            2,
            "unknown type and torn tail are not projected"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn resume_truncates_torn_tail_then_appends_cleanly() {
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
        // Crash mid-append: a torn tail line with no trailing newline.
        append_raw(&dir, r#"{"schema":1,"event_id":"z","seq":3,"typ"#, false);
        let mut store = SessionStore::open(&dir).unwrap();
        let event = store.append(None, EventKind::TurnCompleted).unwrap();
        assert_eq!(event.seq, 3, "torn tail dropped; created(1)+user(2)+new(3)");
        let events = project(&dir).unwrap();
        assert_eq!(
            events.len(),
            3,
            "new event is visible, not eaten by the torn tail"
        );
        assert!(matches!(
            events.last().unwrap().kind,
            EventKind::TurnCompleted
        ));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn resume_seq_advances_past_unknown_future_event() {
        let root = temp_root();
        let dir;
        {
            let store = SessionStore::create(&root, "ws").unwrap();
            dir = store.dir().to_path_buf();
        }
        append_raw(
            &dir,
            r#"{"schema":1,"event_id":"x","seq":50,"turn_id":null,"type":"from_the_future","blob":true}"#,
            true,
        );
        let mut store = SessionStore::open(&dir).unwrap();
        let event = store.append(None, EventKind::TurnCompleted).unwrap();
        assert_eq!(
            event.seq, 51,
            "seq must advance past the unknown future event, not collide"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn project_errors_on_corrupt_complete_line() {
        let root = temp_root();
        let dir;
        {
            let mut store = SessionStore::create(&root, "ws").unwrap();
            dir = store.dir().to_path_buf();
            store
                .append(
                    None,
                    EventKind::UserMessage {
                        text: "a".to_string(),
                    },
                )
                .unwrap();
        }
        // A complete (newline-terminated) line that is not a valid envelope.
        append_raw(&dir, r#"{"schema":1,"seq":}"#, true);
        let err = project(&dir).unwrap_err();
        assert!(
            err.to_string().contains("corrupt"),
            "corrupt complete line must surface, got: {err}"
        );
        fs::remove_dir_all(&root).ok();
    }
}
