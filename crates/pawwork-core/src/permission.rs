//! The permission boundary.
//!
//! The core never prompts: when a tool needs confirmation the loop calls a
//! [`PermissionGate`], which an adapter (CLI, later Tauri) implements against its
//! own UI. Like [`crate::llm::LlmClient`] the gate is generic, not `dyn` — the
//! loop holds one.
//!
//! The request carries a structured action, not a raw JSON blob for the user to
//! eyeball: the tool name, the validated [`PreparedCall`] (the concrete "what will
//! run" — the fenced path, the replacement strings, the command line), and a
//! rendered `summary` for display. [`PreparedCall`] is reused as the typed action
//! rather than a parallel enum: it is already the loop's certified plan, so an
//! adapter can render, diff, or policy-check the exact bytes that will execute,
//! not a lossy string. The ledger's `permission.requested` still records only the
//! `summary` string, so this richer action does not touch the on-disk schema.

use std::future::Future;

use crate::tool::PreparedCall;

/// What the user is being asked to approve.
#[derive(Debug, Clone, PartialEq)]
pub struct PermissionRequest {
    pub tool_name: String,
    /// The validated action that will run if approved — the same [`PreparedCall`]
    /// the loop will hand to the tool. An adapter can inspect it directly (path,
    /// content, command) instead of parsing the rendered summary.
    pub action: PreparedCall,
    /// A rendered, human-readable description of the concrete action. This is also
    /// what the ledger's `permission.requested` records as its `action`.
    pub summary: String,
}

/// The interactive approval boundary, consulted only for tools that require
/// confirmation. `decide` returns `true` to allow, `false` to deny; the future
/// is `Send` for the same multi-thread reason as [`crate::llm::LlmClient`].
pub trait PermissionGate: Send + Sync {
    fn decide(&self, request: &PermissionRequest) -> impl Future<Output = bool> + Send;
}
