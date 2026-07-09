//! The built-in read tool.
//!
//! `read` is auto-allowed (no confirmation) and fenced to the workspace. It reads
//! a file *or* a directory: pointed at a file it returns the (capped) contents,
//! pointed at a directory it returns the (capped, sorted) entry names. Folding the
//! two into one tool matches how the model thinks ("show me this path") and keeps
//! the surface small; the branch is a cheap `is_dir` check in `run`.
//!
//! The filesystem work is synchronous inside the returned future: the reads are
//! bounded (see the caps below), so for M0 an inline `std::fs` call is simpler
//! than a `spawn_blocking` hop. Moving to `spawn_blocking` is a later concern.
//!
//! The caps bound *work*, not just output: a file read stops one byte past the
//! limit instead of slurping a whole file then truncating, and a directory scan
//! stops at a ceiling instead of collecting an unbounded listing. A model pointing
//! at a huge file or directory therefore cannot stall the turn or blow memory.

use std::io::Read;

use serde_json::{json, Value};

use super::fence::resolve_in_workspace;
use super::{BoxFuture, PreparedCall, Tool, ToolContext, ToolResult, MISMATCHED_CALL};

/// Cap on bytes returned by a file read, so a huge file cannot flood the context.
const MAX_READ_BYTES: usize = 64 * 1024;
/// Cap on entries returned by a directory read.
const MAX_LIST_ENTRIES: usize = 1000;
/// Ceiling on directory entries a read will scan into memory before it stops and
/// marks the result truncated. Well above [`MAX_LIST_ENTRIES`] so a normal
/// directory still sorts correctly, but bounded so a pathological one cannot OOM.
const MAX_LIST_SCAN: usize = 10_000;

/// Pull the required `path` string argument out of a tool call's JSON.
fn path_arg(args: &Value) -> Result<&str, String> {
    args.get("path")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "missing required string argument 'path'".to_string())
}

/// `read`: return the (capped) contents of a file, or the (capped, sorted) entry
/// names of a directory, inside the workspace.
pub struct ReadTool;

impl Tool for ReadTool {
    fn name(&self) -> &str {
        "read"
    }

    fn description(&self) -> &str {
        "Read a path inside the workspace. Given a file, returns its contents (long \
         files are truncated). Given a directory, returns its entry names, one per \
         line, sorted. Errors if the path does not exist."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path to a file or directory, relative to the workspace root."
                }
            },
            "required": ["path"],
            "additionalProperties": false
        })
    }

    fn requires_confirmation(&self) -> bool {
        false
    }

    fn prepare(&self, ctx: &ToolContext, args: &Value) -> Result<PreparedCall, String> {
        let requested = path_arg(args)?;
        // `resolve_in_workspace` requires the target to exist, so a genuinely
        // missing path is rejected here. A file or a directory is accepted; `run`
        // branches on which.
        let path = resolve_in_workspace(&ctx.workspace_root, requested)?;
        Ok(PreparedCall::Read { path })
    }

    fn summarize(&self, prepared: &PreparedCall) -> String {
        match prepared {
            PreparedCall::Read { path } => format!("read {}", path.display()),
            _ => "read".to_string(),
        }
    }

    fn run<'a>(
        &'a self,
        _ctx: &'a ToolContext,
        prepared: &'a PreparedCall,
    ) -> BoxFuture<'a, ToolResult> {
        let PreparedCall::Read { path } = prepared else {
            return Box::pin(async { Err(MISMATCHED_CALL.to_string()) });
        };
        Box::pin(async move {
            if path.is_dir() {
                read_directory(path)
            } else {
                read_file(path)
            }
        })
    }
}

/// Read at most one byte past the cap: enough to know the file was longer, without
/// pulling a multi-gigabyte file into memory.
fn read_file(path: &std::path::Path) -> ToolResult {
    let file = std::fs::File::open(path).map_err(|err| format!("read failed: {err}"))?;
    let mut bytes = Vec::new();
    file.take((MAX_READ_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|err| format!("read failed: {err}"))?;
    let truncated = bytes.len() > MAX_READ_BYTES;
    bytes.truncate(MAX_READ_BYTES);
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if truncated {
        text.push_str("\n… [truncated]");
    }
    Ok(text)
}

/// Scan at most [`MAX_LIST_SCAN`] entries, sort, and return the first
/// [`MAX_LIST_ENTRIES`], marking the result truncated if either bound was hit.
fn read_directory(path: &std::path::Path) -> ToolResult {
    let entries = std::fs::read_dir(path).map_err(|err| format!("read failed: {err}"))?;
    let mut names = Vec::new();
    let mut overflowed = false;
    for entry in entries {
        if names.len() >= MAX_LIST_SCAN {
            // Stop scanning a pathological directory; the result is marked
            // truncated below.
            overflowed = true;
            break;
        }
        let entry = entry.map_err(|err| format!("read failed: {err}"))?;
        names.push(entry.file_name().to_string_lossy().into_owned());
    }
    names.sort();
    let truncated = overflowed || names.len() > MAX_LIST_ENTRIES;
    names.truncate(MAX_LIST_ENTRIES);
    let mut out = names.join("\n");
    if truncated {
        out.push_str("\n… [truncated]");
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;
    use tokio_util::sync::CancellationToken;
    use uuid::Uuid;

    struct TempWorkspace {
        root: PathBuf,
    }

    impl TempWorkspace {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("pawwork-fs-{}", Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            let root = root.canonicalize().unwrap();
            TempWorkspace { root }
        }

        fn ctx(&self) -> ToolContext {
            ToolContext {
                workspace_root: self.root.clone(),
                cancel: CancellationToken::new(),
            }
        }
    }

    impl Drop for TempWorkspace {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).ok();
        }
    }

    #[tokio::test]
    async fn read_returns_file_contents() {
        let ws = TempWorkspace::new();
        fs::write(ws.root.join("a.txt"), b"hello").unwrap();
        let ctx = ws.ctx();
        let prepared = ReadTool.prepare(&ctx, &json!({ "path": "a.txt" })).unwrap();
        let out = ReadTool.run(&ctx, &prepared).await.unwrap();
        assert_eq!(out, "hello");
    }

    #[tokio::test]
    async fn read_caps_large_files() {
        let ws = TempWorkspace::new();
        let big = vec![b'x'; MAX_READ_BYTES + 500];
        fs::write(ws.root.join("big.txt"), &big).unwrap();
        let ctx = ws.ctx();
        let prepared = ReadTool
            .prepare(&ctx, &json!({ "path": "big.txt" }))
            .unwrap();
        let out = ReadTool.run(&ctx, &prepared).await.unwrap();
        assert!(out.ends_with("[truncated]"), "large read must be capped");
        assert!(
            out.len() < big.len(),
            "output must be smaller than the file"
        );
    }

    #[tokio::test]
    async fn read_lists_directory_entries_sorted() {
        let ws = TempWorkspace::new();
        fs::write(ws.root.join("b.txt"), b"").unwrap();
        fs::write(ws.root.join("a.txt"), b"").unwrap();
        fs::create_dir(ws.root.join("c")).unwrap();
        let ctx = ws.ctx();
        // read now accepts a directory: it returns the sorted entry names.
        let prepared = ReadTool.prepare(&ctx, &json!({ "path": "." })).unwrap();
        let out = ReadTool.run(&ctx, &prepared).await.unwrap();
        assert_eq!(out, "a.txt\nb.txt\nc");
    }

    #[test]
    fn read_rejects_missing_path_target() {
        let ws = TempWorkspace::new();
        // A genuinely missing target is still rejected (the resolver requires the
        // path to exist); only the file-vs-directory distinction was relaxed.
        let err = ReadTool
            .prepare(&ws.ctx(), &json!({ "path": "nope.txt" }))
            .unwrap_err();
        assert!(err.contains("cannot resolve"), "got: {err}");
    }

    #[test]
    fn read_rejects_missing_path_argument() {
        let ws = TempWorkspace::new();
        let err = ReadTool.prepare(&ws.ctx(), &json!({})).unwrap_err();
        assert!(err.contains("path"), "got: {err}");
    }
}
