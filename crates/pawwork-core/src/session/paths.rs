//! Ledger root resolution.
//!
//! Root = resolve(`PAWWORK_HOME` | `PAWWORK_CONFIG_DIR` | `~/.pawwork`) + `/rs`.
//! The Rust line lives in a `rs/` sub-tree of the shared pawwork home so it
//! follows the same env overrides as the TypeScript product instead of
//! standing up a separate top-level directory.

use std::path::{Path, PathBuf};

/// Absolute ledger root for the current environment.
pub fn ledger_root() -> PathBuf {
    resolve_root(
        env_nonempty("PAWWORK_HOME").as_deref(),
        env_nonempty("PAWWORK_CONFIG_DIR").as_deref(),
        &user_home(),
    )
}

/// Directory holding one session's `events.jsonl`, `meta.json`, and `.lock`.
///
/// Crate-private on purpose: `id` is currently only ever an internally
/// generated UUID. When a resume-by-id path takes user input (later PR), this
/// must validate the id (reject separators / `..` / absolute paths) before it
/// can be exposed, so it is not part of the public API yet.
pub(crate) fn sessions_dir(root: &Path, id: &str) -> PathBuf {
    root.join("sessions").join(id)
}

/// Pure root resolution, separated from env for testability.
pub(crate) fn resolve_root(
    home_env: Option<&str>,
    cfg_env: Option<&str>,
    user_home: &Path,
) -> PathBuf {
    let base = match home_env.or(cfg_env) {
        Some(value) => expand_tilde(value, user_home),
        None => user_home.join(".pawwork"),
    };
    base.join("rs")
}

fn expand_tilde(value: &str, user_home: &Path) -> PathBuf {
    if value == "~" {
        return user_home.to_path_buf();
    }
    if let Some(rest) = value.strip_prefix("~/") {
        return user_home.join(rest);
    }
    PathBuf::from(value)
}

fn env_nonempty(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn user_home() -> PathBuf {
    #[cfg(windows)]
    if let Some(profile) = std::env::var_os("USERPROFILE") {
        return PathBuf::from(profile);
    }
    if let Some(home) = std::env::var_os("HOME") {
        return PathBuf::from(home);
    }
    PathBuf::from(".")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_root_is_pawwork_rs() {
        let home = Path::new("/home/u");
        assert_eq!(
            resolve_root(None, None, home),
            Path::new("/home/u/.pawwork/rs")
        );
    }

    #[test]
    fn home_env_overrides_and_expands_tilde() {
        let home = Path::new("/home/u");
        assert_eq!(
            resolve_root(Some("~/custom"), None, home),
            Path::new("/home/u/custom/rs")
        );
        assert_eq!(
            resolve_root(Some("/abs/path"), None, home),
            Path::new("/abs/path/rs")
        );
    }

    #[test]
    fn config_dir_used_only_when_home_absent() {
        let home = Path::new("/home/u");
        assert_eq!(resolve_root(None, Some("/cfg"), home), Path::new("/cfg/rs"));
        assert_eq!(
            resolve_root(Some("/win"), Some("/cfg"), home),
            Path::new("/win/rs")
        );
    }
}
