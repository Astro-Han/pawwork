//! Workspace path fence.
//!
//! This is an advisory fence, not a sandbox: it keeps a cooperating model from
//! reading outside the workspace by mistake. It does not defend against TOCTOU
//! races (a path can change between the check and the open) and is not an OS-level
//! confinement boundary — that is deferred (seatbelt et al.). The fence anchors
//! only the file tools; `shell`'s boundary is confirmation, not this.
//!
//! Resolution canonicalizes both the workspace root (once, by the caller) and the
//! requested target, then requires the target to be *under* the root by path
//! component (`Path::starts_with`), never by string prefix — so `/ws-evil` cannot
//! masquerade as being inside `/ws`. Canonicalization resolves symlinks, so a
//! symlink pointing outside the root is rejected, and it requires the target to
//! exist, which is exactly right for the read-only `read` tool.
//!
//! `write` cannot use that resolver: canonicalizing a not-yet-created file fails
//! (there is nothing to resolve), so [`resolve_new_in_workspace`] fences the
//! *parent* directory instead and re-attaches a plain filename. Fencing the parent
//! still resolves a symlinked directory that escapes the workspace, so the safety
//! property is preserved; only the "target must already exist" precondition is
//! dropped.

use std::path::{Path, PathBuf};

/// Resolve `requested` against an already-canonicalized `root`, returning the
/// canonical target iff it stays inside the workspace.
///
/// `requested` may be relative (joined onto `root`) or absolute (which replaces
/// `root` in the join, then must still canonicalize back inside it).
pub fn resolve_in_workspace(root: &Path, requested: &str) -> Result<PathBuf, String> {
    if requested.trim().is_empty() {
        return Err("empty path".to_string());
    }
    let candidate = root.join(requested);
    let canonical = candidate
        .canonicalize()
        .map_err(|err| format!("cannot resolve '{requested}': {err}"))?;
    if !canonical.starts_with(root) {
        return Err(format!("path '{requested}' escapes the workspace"));
    }
    Ok(canonical)
}

/// Resolve a `write` target that may not yet exist, returning the canonical path
/// to write to iff it stays inside the workspace.
///
/// Two cases:
/// - The target **already exists**: canonicalize and fence it like a read, but
///   require it to be a plain file. Overwriting a file is fine; a directory target
///   is an error, not a silent no-op.
/// - The target **does not exist** (the create case): its parent must exist —
///   intermediate directories are never created here (the model can `mkdir` via
///   `shell` under confirmation). Canonicalize and fence the *parent*, which
///   rejects a symlinked parent escaping the workspace, then re-attach the final
///   component. That component must be a plain filename: empty, `.`, `..`, or a
///   value carrying a path separator is rejected.
pub fn resolve_new_in_workspace(root: &Path, requested: &str) -> Result<PathBuf, String> {
    if requested.trim().is_empty() {
        return Err("empty path".to_string());
    }
    let candidate = root.join(requested);

    if candidate.exists() {
        let canonical = candidate
            .canonicalize()
            .map_err(|err| format!("cannot resolve '{requested}': {err}"))?;
        if !canonical.starts_with(root) {
            return Err(format!("path '{requested}' escapes the workspace"));
        }
        if !canonical.is_file() {
            return Err(format!("'{requested}' is a directory, not a file"));
        }
        return Ok(canonical);
    }

    // The create case. `file_name` returns `None` for a path ending in `.` or
    // `..` (and for the root), so a final component that is not a real filename is
    // rejected before we touch the filesystem.
    let file_name = candidate
        .file_name()
        .ok_or_else(|| format!("path '{requested}' does not name a file"))?;
    let parent = candidate
        .parent()
        .ok_or_else(|| format!("path '{requested}' has no parent directory"))?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|err| format!("cannot resolve parent of '{requested}': {err}"))?;
    if !canonical_parent.starts_with(root) {
        return Err(format!("path '{requested}' escapes the workspace"));
    }
    if !canonical_parent.is_dir() {
        return Err(format!("parent of '{requested}' is not a directory"));
    }
    Ok(canonical_parent.join(file_name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use uuid::Uuid;

    struct TempWorkspace {
        root: PathBuf,
    }

    impl TempWorkspace {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("pawwork-fence-{}", Uuid::new_v4()));
            fs::create_dir_all(&root).unwrap();
            // Canonicalize the root the way the agent does at startup (temp dirs
            // are often symlinked, e.g. /var -> /private/var on macOS).
            let root = root.canonicalize().unwrap();
            TempWorkspace { root }
        }
    }

    impl Drop for TempWorkspace {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).ok();
        }
    }

    #[test]
    fn accepts_path_inside_workspace() {
        let ws = TempWorkspace::new();
        fs::write(ws.root.join("note.txt"), b"hi").unwrap();
        let resolved = resolve_in_workspace(&ws.root, "note.txt").unwrap();
        assert_eq!(resolved, ws.root.join("note.txt"));
    }

    #[test]
    fn accepts_the_root_itself() {
        let ws = TempWorkspace::new();
        let resolved = resolve_in_workspace(&ws.root, ".").unwrap();
        assert_eq!(resolved, ws.root);
    }

    #[test]
    fn rejects_absolute_path_outside() {
        let ws = TempWorkspace::new();
        let err = resolve_in_workspace(&ws.root, "/etc/hosts").unwrap_err();
        assert!(err.contains("escapes"), "got: {err}");
    }

    #[test]
    fn rejects_dotdot_escape() {
        let ws = TempWorkspace::new();
        let err = resolve_in_workspace(&ws.root, "../../etc/hosts").unwrap_err();
        // Either it escapes, or the traversed path does not exist — both are a
        // refusal, never a success.
        assert!(
            err.contains("escapes") || err.contains("cannot resolve"),
            "got: {err}"
        );
    }

    #[test]
    fn rejects_symlink_pointing_outside() {
        let ws = TempWorkspace::new();
        let outside = std::env::temp_dir().join(format!("pawwork-outside-{}", Uuid::new_v4()));
        fs::write(&outside, b"secret").unwrap();
        let link = ws.root.join("escape");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(&outside, &link).unwrap();
        let err = resolve_in_workspace(&ws.root, "escape").unwrap_err();
        assert!(
            err.contains("escapes"),
            "symlink out must be rejected, got: {err}"
        );
        fs::remove_file(&outside).ok();
    }

    #[test]
    fn rejects_missing_path() {
        let ws = TempWorkspace::new();
        let err = resolve_in_workspace(&ws.root, "nope.txt").unwrap_err();
        assert!(err.contains("cannot resolve"), "got: {err}");
    }

    #[test]
    fn rejects_sibling_with_shared_prefix() {
        // A component-wise check must not treat `/tmp/ws-evil` as inside `/tmp/ws`.
        let base = std::env::temp_dir().join(format!("pawwork-prefix-{}", Uuid::new_v4()));
        let root = base.join("ws");
        let sibling = base.join("ws-evil");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&sibling).unwrap();
        let root = root.canonicalize().unwrap();
        fs::write(sibling.join("f.txt"), b"x").unwrap();
        let err = resolve_in_workspace(&root, "../ws-evil/f.txt").unwrap_err();
        assert!(
            err.contains("escapes"),
            "sibling prefix must be rejected, got: {err}"
        );
        fs::remove_dir_all(&base).ok();
    }

    // --- resolve_new_in_workspace (write targets) ------------------------

    #[test]
    fn new_file_in_root_is_accepted() {
        let ws = TempWorkspace::new();
        let resolved = resolve_new_in_workspace(&ws.root, "new.txt").unwrap();
        assert_eq!(resolved, ws.root.join("new.txt"));
    }

    #[test]
    fn new_file_in_existing_subdir_is_accepted() {
        let ws = TempWorkspace::new();
        fs::create_dir(ws.root.join("sub")).unwrap();
        let resolved = resolve_new_in_workspace(&ws.root, "sub/new.txt").unwrap();
        assert_eq!(resolved, ws.root.join("sub").join("new.txt"));
    }

    #[test]
    fn new_file_with_missing_parent_is_rejected() {
        let ws = TempWorkspace::new();
        // The resolver must not create intermediate directories.
        let err = resolve_new_in_workspace(&ws.root, "nodir/new.txt").unwrap_err();
        assert!(err.contains("cannot resolve parent"), "got: {err}");
        assert!(
            !ws.root.join("nodir").exists(),
            "must not have created a dir"
        );
    }

    #[test]
    fn new_file_with_parent_outside_root_is_rejected() {
        let ws = TempWorkspace::new();
        let err = resolve_new_in_workspace(&ws.root, "/etc/pawwork-new-xyz.txt").unwrap_err();
        assert!(
            err.contains("escapes") || err.contains("cannot resolve parent"),
            "got: {err}"
        );
    }

    #[test]
    fn new_file_with_dotdot_final_component_is_rejected() {
        let ws = TempWorkspace::new();
        fs::create_dir(ws.root.join("sub")).unwrap();
        // `sub/..` resolves to the (existing) root directory: a directory target,
        // never a writable file.
        let err = resolve_new_in_workspace(&ws.root, "sub/..").unwrap_err();
        assert!(
            err.contains("directory") || err.contains("does not name a file"),
            "got: {err}"
        );
    }

    #[test]
    fn overwrite_existing_file_is_accepted() {
        let ws = TempWorkspace::new();
        fs::write(ws.root.join("exists.txt"), b"old").unwrap();
        let resolved = resolve_new_in_workspace(&ws.root, "exists.txt").unwrap();
        assert_eq!(resolved, ws.root.join("exists.txt"));
    }

    #[test]
    fn existing_directory_target_is_rejected() {
        let ws = TempWorkspace::new();
        fs::create_dir(ws.root.join("adir")).unwrap();
        let err = resolve_new_in_workspace(&ws.root, "adir").unwrap_err();
        assert!(err.contains("directory"), "got: {err}");
    }

    #[test]
    fn symlinked_parent_escaping_is_rejected() {
        let ws = TempWorkspace::new();
        // A directory outside the workspace, reached via a symlink inside it. The
        // fence must resolve the symlink and reject the escape.
        let outside = std::env::temp_dir().join(format!("pawwork-outdir-{}", Uuid::new_v4()));
        fs::create_dir_all(&outside).unwrap();
        let link = ws.root.join("linkdir");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&outside, &link).unwrap();
        let err = resolve_new_in_workspace(&ws.root, "linkdir/new.txt").unwrap_err();
        assert!(
            err.contains("escapes"),
            "a symlinked parent escaping the root must be rejected, got: {err}"
        );
        fs::remove_dir_all(&outside).ok();
    }
}
