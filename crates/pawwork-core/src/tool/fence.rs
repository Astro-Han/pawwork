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
//! exist, which is exactly right for the read-only `read`/`list` tools.

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
}
