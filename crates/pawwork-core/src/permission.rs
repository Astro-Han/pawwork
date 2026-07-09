//! The permission boundary.
//!
//! The core never prompts: when a tool needs confirmation the loop calls a
//! [`PermissionGate`], which an adapter (CLI, later Tauri) implements against its
//! own UI. Like [`crate::llm::LlmClient`] the gate is generic, not `dyn` — the
//! loop holds one.
//!
//! The request is structured, not a raw JSON blob for the user to eyeball: PR2
//! carries the tool name and a rendered human summary. A richer typed action
//! enum (read-path / write-file / shell-command) lands with `edit`/`shell`, its
//! first real producers; introducing those variants now would be speculative
//! dead code, since PR2's only tools (`read`/`list`) are auto-allowed and never
//! reach the gate.

use std::future::Future;

/// What the user is being asked to approve.
#[derive(Debug, Clone, PartialEq)]
pub struct PermissionRequest {
    pub tool_name: String,
    /// A rendered, human-readable description of the concrete action. This is
    /// also what the ledger's `permission.requested` records as its `action`.
    pub summary: String,
}

/// The interactive approval boundary, consulted only for tools that require
/// confirmation. `decide` returns `true` to allow, `false` to deny; the future
/// is `Send` for the same multi-thread reason as [`crate::llm::LlmClient`].
pub trait PermissionGate: Send + Sync {
    fn decide(&self, request: &PermissionRequest) -> impl Future<Output = bool> + Send;
}
