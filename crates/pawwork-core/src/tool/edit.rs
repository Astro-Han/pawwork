//! The write-side file tools: `edit` and `write`.
//!
//! Both mutate a workspace file, so both require confirmation and both land their
//! change through one [`atomic_write`] helper (write a sibling temp file, then
//! rename over the target) so a reader never sees a half-written file. Grouping
//! them here keeps the "changes a file on disk" surface in one place, next to the
//! atomicity guarantee they share.
//!
//! `edit` is an **exact** substring replacement, deliberately not the fuzzy
//! replacer cascade the TypeScript tool grew: exactly one occurrence of
//! `old_string` must match or the edit fails. Exact matching is predictable and
//! reviewable; a fuzzy match that silently edits the wrong line is the failure
//! mode a confirmation gate cannot catch. `write` replaces (or creates) a whole
//! file.

use std::io::Read;
use std::path::Path;

use serde_json::{json, Value};
use uuid::Uuid;

use super::fence::{resolve_in_workspace, resolve_new_in_workspace};
use super::{BoxFuture, PreparedCall, Tool, ToolContext, ToolResult, MISMATCHED_CALL};

/// Cap on the size of a file `edit` will load. Same work-bounding philosophy as
/// `read`'s cap: exact string matching over a multi-gigabyte file would stall the
/// turn and blow memory, and an edit target that large is not a real edit.
const MAX_EDIT_BYTES: usize = 8 * 1024 * 1024;

/// Pull a required string argument. Unlike [`super::fs`]'s `path_arg`, this does
/// not reject an empty value — `write`'s `content` may legitimately be `""`.
fn string_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing required string argument '{key}'"))
}

/// Write `content` to `path` atomically: stage it in a uniquely-named sibling temp
/// file in the same directory, then `rename` over the target. `rename` within one
/// directory is atomic on the platforms we target, so a concurrent reader sees
/// either the old file or the new one, never a partial write. No `fsync`:
/// durability across a crash is an explicitly deferred concern. The temp file is
/// removed on any failure so a stray partial write is never left behind.
fn atomic_write(path: &Path, content: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "target has no parent directory".to_string())?;
    let temp = parent.join(format!(".pawwork-tmp-{}", Uuid::new_v4()));
    let existing = std::fs::metadata(path).ok();
    if let Err(err) = write_temp(&temp, content, existing.as_ref()) {
        std::fs::remove_file(&temp).ok();
        return Err(format!("write failed: {err}"));
    }
    if let Err(err) = std::fs::rename(&temp, path) {
        std::fs::remove_file(&temp).ok();
        return Err(format!("write failed: {err}"));
    }
    Ok(())
}

/// Stage the temp file without ever being more readable than the final target.
///
/// The rename installs the temp's inode, so the target's permissions must be
/// carried onto the temp or a 0755 script turns non-executable and a 0600 file
/// widens to the umask default. Order matters for secrecy too: when replacing an
/// existing file the temp is *created* 0600 (unix) before any content is written,
/// then tightened/relaxed to the target's exact mode — so there is no window (or
/// crash residue) in which private content sits in a default-mode temp. A missing
/// target is a create, where the default umask mode matches the final state.
fn write_temp(
    temp: &Path,
    content: &[u8],
    existing: Option<&std::fs::Metadata>,
) -> std::io::Result<()> {
    use std::io::Write;

    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    if existing.is_some() {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(temp)?;
    file.write_all(content)?;
    drop(file);
    if let Some(metadata) = existing {
        std::fs::set_permissions(temp, metadata.permissions())?;
    }
    Ok(())
}

/// Count occurrences of `needle` in `haystack`, **including overlapping ones**,
/// stopping at 2 (the caller only distinguishes zero / one / many). `str::matches`
/// counts non-overlapping occurrences only, which would let `aa` in `aaa` pass as
/// unique when two valid match positions exist — an ambiguous edit slipping the
/// exactly-once contract. The early stop also bounds the scan: a pathological
/// self-overlapping needle over an 8 MiB file cannot go quadratic.
fn count_matches_capped(haystack: &str, needle: &str) -> usize {
    debug_assert!(!needle.is_empty(), "prepare rejects an empty old_string");
    let mut count = 0;
    let mut from = 0;
    while let Some(found) = haystack[from..].find(needle) {
        count += 1;
        if count >= 2 {
            break;
        }
        // Advance by one full character (not one byte) past the match start so
        // overlapping candidates are seen and the slice stays on a char boundary.
        let first_char = needle.chars().next().map_or(1, char::len_utf8);
        from += found + first_char;
    }
    count
}

/// `edit`: replace the single occurrence of `old_string` with `new_string` in a
/// file inside the workspace.
pub struct EditTool;

impl Tool for EditTool {
    fn name(&self) -> &str {
        "edit"
    }

    fn description(&self) -> &str {
        "Replace an exact substring in an existing workspace file. old_string must \
         match exactly once; if it is missing or appears more than once the edit \
         fails, so include enough surrounding context to make it unique. Preserve \
         exact whitespace. Use write to create a new file or replace one wholesale."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path to the file to edit, relative to the workspace root."
                },
                "old_string": {
                    "type": "string",
                    "description": "The exact text to replace. Must occur exactly once."
                },
                "new_string": {
                    "type": "string",
                    "description": "The text to replace it with."
                }
            },
            "required": ["path", "old_string", "new_string"],
            "additionalProperties": false
        })
    }

    fn requires_confirmation(&self) -> bool {
        true
    }

    fn prepare(&self, ctx: &ToolContext, args: &Value) -> Result<PreparedCall, String> {
        let requested = string_arg(args, "path")?;
        let old = string_arg(args, "old_string")?;
        let new = string_arg(args, "new_string")?;
        if old.is_empty() {
            return Err("old_string must not be empty".to_string());
        }
        if old == new {
            return Err("old_string and new_string are identical; nothing to change".to_string());
        }
        let path = resolve_in_workspace(&ctx.workspace_root, requested)?;
        if !path.is_file() {
            return Err(format!("'{requested}' is not a file"));
        }
        Ok(PreparedCall::Edit {
            path,
            old: old.to_string(),
            new: new.to_string(),
        })
    }

    fn summarize(&self, prepared: &PreparedCall) -> String {
        match prepared {
            PreparedCall::Edit { path, .. } => format!("edit {}", path.display()),
            _ => "edit".to_string(),
        }
    }

    fn run<'a>(
        &'a self,
        _ctx: &'a ToolContext,
        prepared: &'a PreparedCall,
    ) -> BoxFuture<'a, ToolResult> {
        let PreparedCall::Edit { path, old, new } = prepared else {
            return Box::pin(async { Err(MISMATCHED_CALL.to_string()) });
        };
        Box::pin(async move {
            // Read at most one byte past the cap so an oversized file is rejected
            // without loading it whole.
            let file = std::fs::File::open(path).map_err(|err| format!("read failed: {err}"))?;
            let mut bytes = Vec::new();
            file.take((MAX_EDIT_BYTES + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|err| format!("read failed: {err}"))?;
            if bytes.len() > MAX_EDIT_BYTES {
                return Err(format!(
                    "file is too large to edit (over {MAX_EDIT_BYTES} bytes)"
                ));
            }
            // Exact matching on a lossy conversion would corrupt the file on
            // write-back, so a non-UTF-8 file is refused, not mangled.
            let text = String::from_utf8(bytes).map_err(|_| {
                "file is not valid UTF-8; edit requires exact text matching".to_string()
            })?;
            match count_matches_capped(&text, old) {
                0 => return Err("no match: old_string was not found in the file".to_string()),
                1 => {}
                _ => {
                    return Err(
                        "ambiguous edit: old_string appears more than once; include more \
                         surrounding context so it matches exactly once"
                            .to_string(),
                    )
                }
            }
            let updated = text.replacen(old.as_str(), new.as_str(), 1);
            atomic_write(path, updated.as_bytes())?;
            Ok(format!("edited {}", path.display()))
        })
    }
}

/// `write`: create a new file, or overwrite an existing one, inside the workspace.
pub struct WriteTool;

impl Tool for WriteTool {
    fn name(&self) -> &str {
        "write"
    }

    fn description(&self) -> &str {
        "Write content to a workspace file, creating it or overwriting it whole. \
         The parent directory must already exist. Prefer edit for a small change to \
         an existing file."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path to the file to write, relative to the workspace root."
                },
                "content": {
                    "type": "string",
                    "description": "The full contents to write. May be empty."
                }
            },
            "required": ["path", "content"],
            "additionalProperties": false
        })
    }

    fn requires_confirmation(&self) -> bool {
        true
    }

    fn prepare(&self, ctx: &ToolContext, args: &Value) -> Result<PreparedCall, String> {
        let requested = string_arg(args, "path")?;
        let content = string_arg(args, "content")?;
        let path = resolve_new_in_workspace(&ctx.workspace_root, requested)?;
        Ok(PreparedCall::Write {
            path,
            content: content.to_string(),
        })
    }

    fn summarize(&self, prepared: &PreparedCall) -> String {
        match prepared {
            PreparedCall::Write { path, content } => {
                format!("write {} ({} bytes)", path.display(), content.len())
            }
            _ => "write".to_string(),
        }
    }

    fn run<'a>(
        &'a self,
        _ctx: &'a ToolContext,
        prepared: &'a PreparedCall,
    ) -> BoxFuture<'a, ToolResult> {
        let PreparedCall::Write { path, content } = prepared else {
            return Box::pin(async { Err(MISMATCHED_CALL.to_string()) });
        };
        Box::pin(async move {
            atomic_write(path, content.as_bytes())?;
            Ok(format!(
                "wrote {} ({} bytes)",
                path.display(),
                content.len()
            ))
        })
    }
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
            let root = std::env::temp_dir().join(format!("pawwork-edit-{}", Uuid::new_v4()));
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

    // --- edit ------------------------------------------------------------

    #[tokio::test]
    async fn edit_replaces_the_single_match_exactly() {
        let ws = TempWorkspace::new();
        fs::write(ws.root.join("a.txt"), b"hello world\n").unwrap();
        let ctx = ws.ctx();
        let prepared = EditTool
            .prepare(
                &ctx,
                &json!({ "path": "a.txt", "old_string": "world", "new_string": "there" }),
            )
            .unwrap();
        EditTool.run(&ctx, &prepared).await.unwrap();
        let after = fs::read_to_string(ws.root.join("a.txt")).unwrap();
        assert_eq!(after, "hello there\n", "content must be exactly replaced");
    }

    #[tokio::test]
    async fn edit_with_no_match_errors() {
        let ws = TempWorkspace::new();
        fs::write(ws.root.join("a.txt"), b"hello").unwrap();
        let ctx = ws.ctx();
        let prepared = EditTool
            .prepare(
                &ctx,
                &json!({ "path": "a.txt", "old_string": "absent", "new_string": "x" }),
            )
            .unwrap();
        let err = EditTool.run(&ctx, &prepared).await.unwrap_err();
        assert!(err.contains("no match"), "got: {err}");
    }

    #[tokio::test]
    async fn edit_with_multiple_matches_reports_ambiguity() {
        let ws = TempWorkspace::new();
        fs::write(ws.root.join("a.txt"), b"a a a").unwrap();
        let ctx = ws.ctx();
        let prepared = EditTool
            .prepare(
                &ctx,
                &json!({ "path": "a.txt", "old_string": "a", "new_string": "b" }),
            )
            .unwrap();
        let err = EditTool.run(&ctx, &prepared).await.unwrap_err();
        assert!(err.contains("ambiguous"), "got: {err}");
    }

    #[tokio::test]
    async fn edit_detects_overlapping_matches_as_ambiguous() {
        // `str::matches` would count only one non-overlapping `aa` in `aaa`, but
        // two valid match positions exist — the edit is ambiguous and must fail.
        let ws = TempWorkspace::new();
        fs::write(ws.root.join("a.txt"), b"aaa").unwrap();
        let ctx = ws.ctx();
        let prepared = EditTool
            .prepare(
                &ctx,
                &json!({ "path": "a.txt", "old_string": "aa", "new_string": "b" }),
            )
            .unwrap();
        let err = EditTool.run(&ctx, &prepared).await.unwrap_err();
        assert!(err.contains("ambiguous"), "got: {err}");
        assert_eq!(
            fs::read_to_string(ws.root.join("a.txt")).unwrap(),
            "aaa",
            "an ambiguous edit must not touch the file"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn edit_preserves_the_target_file_mode() {
        use std::os::unix::fs::PermissionsExt;
        let ws = TempWorkspace::new();
        let script = ws.root.join("run.sh");
        fs::write(&script, b"echo old").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        let ctx = ws.ctx();
        let prepared = EditTool
            .prepare(
                &ctx,
                &json!({ "path": "run.sh", "old_string": "old", "new_string": "new" }),
            )
            .unwrap();
        EditTool.run(&ctx, &prepared).await.unwrap();
        let mode = fs::metadata(&script).unwrap().permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o755,
            "the atomic replacement must keep the target executable"
        );
    }

    #[test]
    fn edit_rejects_identical_old_and_new_at_prepare() {
        let ws = TempWorkspace::new();
        fs::write(ws.root.join("a.txt"), b"x").unwrap();
        let err = EditTool
            .prepare(
                &ws.ctx(),
                &json!({ "path": "a.txt", "old_string": "x", "new_string": "x" }),
            )
            .unwrap_err();
        assert!(err.contains("identical"), "got: {err}");
    }

    #[test]
    fn edit_rejects_empty_old_string_at_prepare() {
        let ws = TempWorkspace::new();
        fs::write(ws.root.join("a.txt"), b"x").unwrap();
        let err = EditTool
            .prepare(
                &ws.ctx(),
                &json!({ "path": "a.txt", "old_string": "", "new_string": "y" }),
            )
            .unwrap_err();
        assert!(err.contains("empty"), "got: {err}");
    }

    #[tokio::test]
    async fn edit_rejects_non_utf8_file() {
        let ws = TempWorkspace::new();
        // An invalid UTF-8 byte sequence.
        fs::write(ws.root.join("bin.dat"), [0xff, 0xfe, 0x00]).unwrap();
        let ctx = ws.ctx();
        let prepared = EditTool
            .prepare(
                &ctx,
                &json!({ "path": "bin.dat", "old_string": "x", "new_string": "y" }),
            )
            .unwrap();
        let err = EditTool.run(&ctx, &prepared).await.unwrap_err();
        assert!(err.contains("UTF-8"), "got: {err}");
    }

    #[test]
    fn edit_rejects_escape_at_prepare() {
        let ws = TempWorkspace::new();
        let err = EditTool
            .prepare(
                &ws.ctx(),
                &json!({ "path": "/etc/hosts", "old_string": "a", "new_string": "b" }),
            )
            .unwrap_err();
        assert!(err.contains("escapes"), "got: {err}");
    }

    #[test]
    fn edit_rejects_missing_file_at_prepare() {
        let ws = TempWorkspace::new();
        let err = EditTool
            .prepare(
                &ws.ctx(),
                &json!({ "path": "nope.txt", "old_string": "a", "new_string": "b" }),
            )
            .unwrap_err();
        assert!(err.contains("cannot resolve"), "got: {err}");
    }

    // --- write -----------------------------------------------------------

    #[tokio::test]
    async fn write_creates_a_new_file() {
        let ws = TempWorkspace::new();
        let ctx = ws.ctx();
        let prepared = WriteTool
            .prepare(&ctx, &json!({ "path": "new.txt", "content": "fresh" }))
            .unwrap();
        WriteTool.run(&ctx, &prepared).await.unwrap();
        assert_eq!(
            fs::read_to_string(ws.root.join("new.txt")).unwrap(),
            "fresh"
        );
    }

    #[tokio::test]
    async fn write_overwrites_an_existing_file() {
        let ws = TempWorkspace::new();
        fs::write(ws.root.join("f.txt"), b"old contents").unwrap();
        let ctx = ws.ctx();
        let prepared = WriteTool
            .prepare(&ctx, &json!({ "path": "f.txt", "content": "new" }))
            .unwrap();
        WriteTool.run(&ctx, &prepared).await.unwrap();
        assert_eq!(fs::read_to_string(ws.root.join("f.txt")).unwrap(), "new");
    }

    #[tokio::test]
    async fn write_allows_empty_content() {
        let ws = TempWorkspace::new();
        let ctx = ws.ctx();
        let prepared = WriteTool
            .prepare(&ctx, &json!({ "path": "empty.txt", "content": "" }))
            .unwrap();
        WriteTool.run(&ctx, &prepared).await.unwrap();
        assert_eq!(fs::read_to_string(ws.root.join("empty.txt")).unwrap(), "");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn write_preserves_a_private_file_mode() {
        use std::os::unix::fs::PermissionsExt;
        let ws = TempWorkspace::new();
        let secret = ws.root.join("secret.txt");
        fs::write(&secret, b"old").unwrap();
        fs::set_permissions(&secret, fs::Permissions::from_mode(0o600)).unwrap();
        let ctx = ws.ctx();
        let prepared = WriteTool
            .prepare(&ctx, &json!({ "path": "secret.txt", "content": "new" }))
            .unwrap();
        WriteTool.run(&ctx, &prepared).await.unwrap();
        let mode = fs::metadata(&secret).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "overwriting must not widen a private file");
        assert_eq!(fs::read_to_string(&secret).unwrap(), "new");
    }

    #[test]
    fn write_rejects_missing_parent_at_prepare() {
        let ws = TempWorkspace::new();
        let err = WriteTool
            .prepare(&ws.ctx(), &json!({ "path": "nodir/f.txt", "content": "x" }))
            .unwrap_err();
        assert!(err.contains("cannot resolve parent"), "got: {err}");
    }

    #[test]
    fn write_rejects_escape_at_prepare() {
        let ws = TempWorkspace::new();
        let err = WriteTool
            .prepare(
                &ws.ctx(),
                &json!({ "path": "/etc/pawwork-x.txt", "content": "x" }),
            )
            .unwrap_err();
        assert!(
            err.contains("escapes") || err.contains("cannot resolve parent"),
            "got: {err}"
        );
    }
}
