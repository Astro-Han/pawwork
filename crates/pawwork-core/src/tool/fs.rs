//! Built-in read-only tools: `read` and `list`.
//!
//! Both are auto-allowed (no confirmation) and fenced to the workspace. Their
//! filesystem work is synchronous inside the returned future: the reads are
//! bounded (see the caps below), so for M0 an inline `std::fs` call is simpler
//! than a `spawn_blocking` hop (which would also force the core to pull a runtime
//! feature it otherwise avoids). Moving to `spawn_blocking` is a later concern.
//!
//! The caps bound *work*, not just output: `read` reads at most one byte past the
//! limit instead of slurping a whole file then truncating, and `list` stops
//! scanning at a ceiling instead of collecting an unbounded directory. A model
//! pointing at a huge file or directory therefore cannot stall the turn or blow
//! memory.

use std::io::Read;

use serde_json::Value;

use super::fence::resolve_in_workspace;
use super::{BoxFuture, PreparedCall, Tool, ToolContext, ToolResult};

/// Cap on bytes returned by `read`, so a huge file cannot flood the context.
const MAX_READ_BYTES: usize = 64 * 1024;
/// Cap on entries returned by `list`.
const MAX_LIST_ENTRIES: usize = 1000;
/// Ceiling on directory entries `list` will scan into memory before it stops and
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

/// `read`: return the (capped) UTF-8 contents of a file inside the workspace.
pub struct ReadTool;

impl Tool for ReadTool {
    fn name(&self) -> &str {
        "read"
    }

    fn requires_confirmation(&self) -> bool {
        false
    }

    fn prepare(&self, ctx: &ToolContext, args: &Value) -> Result<PreparedCall, String> {
        let requested = path_arg(args)?;
        let path = resolve_in_workspace(&ctx.workspace_root, requested)?;
        if !path.is_file() {
            return Err(format!("'{requested}' is not a file"));
        }
        Ok(PreparedCall { path })
    }

    fn summarize(&self, prepared: &PreparedCall) -> String {
        format!("read {}", prepared.path.display())
    }

    fn run<'a>(
        &'a self,
        _ctx: &'a ToolContext,
        prepared: &'a PreparedCall,
    ) -> BoxFuture<'a, ToolResult> {
        Box::pin(async move {
            // Read at most one byte past the cap: enough to know the file was
            // longer, without pulling a multi-gigabyte file into memory.
            let file =
                std::fs::File::open(&prepared.path).map_err(|err| format!("read failed: {err}"))?;
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
        })
    }
}

/// `list`: return the (capped, sorted) entry names of a directory inside the
/// workspace.
pub struct ListTool;

impl Tool for ListTool {
    fn name(&self) -> &str {
        "list"
    }

    fn requires_confirmation(&self) -> bool {
        false
    }

    fn prepare(&self, ctx: &ToolContext, args: &Value) -> Result<PreparedCall, String> {
        let requested = path_arg(args)?;
        let path = resolve_in_workspace(&ctx.workspace_root, requested)?;
        if !path.is_dir() {
            return Err(format!("'{requested}' is not a directory"));
        }
        Ok(PreparedCall { path })
    }

    fn summarize(&self, prepared: &PreparedCall) -> String {
        format!("list {}", prepared.path.display())
    }

    fn run<'a>(
        &'a self,
        _ctx: &'a ToolContext,
        prepared: &'a PreparedCall,
    ) -> BoxFuture<'a, ToolResult> {
        Box::pin(async move {
            let entries =
                std::fs::read_dir(&prepared.path).map_err(|err| format!("list failed: {err}"))?;
            let mut names = Vec::new();
            let mut overflowed = false;
            for entry in entries {
                if names.len() >= MAX_LIST_SCAN {
                    // Stop scanning a pathological directory; the result is marked
                    // truncated below.
                    overflowed = true;
                    break;
                }
                let entry = entry.map_err(|err| format!("list failed: {err}"))?;
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
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;
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

    #[test]
    fn read_rejects_directory_at_prepare() {
        let ws = TempWorkspace::new();
        fs::create_dir(ws.root.join("sub")).unwrap();
        let err = ReadTool
            .prepare(&ws.ctx(), &json!({ "path": "sub" }))
            .unwrap_err();
        assert!(err.contains("not a file"), "got: {err}");
    }

    #[test]
    fn read_rejects_missing_path_argument() {
        let ws = TempWorkspace::new();
        let err = ReadTool.prepare(&ws.ctx(), &json!({})).unwrap_err();
        assert!(err.contains("path"), "got: {err}");
    }

    #[tokio::test]
    async fn list_returns_sorted_names() {
        let ws = TempWorkspace::new();
        fs::write(ws.root.join("b.txt"), b"").unwrap();
        fs::write(ws.root.join("a.txt"), b"").unwrap();
        fs::create_dir(ws.root.join("c")).unwrap();
        let ctx = ws.ctx();
        let prepared = ListTool.prepare(&ctx, &json!({ "path": "." })).unwrap();
        let out = ListTool.run(&ctx, &prepared).await.unwrap();
        assert_eq!(out, "a.txt\nb.txt\nc");
    }

    #[test]
    fn list_rejects_file_at_prepare() {
        let ws = TempWorkspace::new();
        fs::write(ws.root.join("f.txt"), b"").unwrap();
        let err = ListTool
            .prepare(&ws.ctx(), &json!({ "path": "f.txt" }))
            .unwrap_err();
        assert!(err.contains("not a directory"), "got: {err}");
    }
}
