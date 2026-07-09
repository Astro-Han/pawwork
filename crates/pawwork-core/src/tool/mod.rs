//! The tool boundary and runtime.
//!
//! Unlike the single-instance [`crate::llm::LlmClient`] / [`crate::permission::PermissionGate`]
//! seams, tools are a heterogeneous set, so [`Tool`] is used behind `dyn`. Native
//! `async fn` in traits is not `dyn`-compatible, so `run` returns a hand-boxed
//! [`BoxFuture`] — one type alias, no `async-trait` dependency.
//!
//! Execution is split into `prepare` then `run` so that "never execute a
//! malformed call" is a type-level guarantee, not a comment: `prepare` does all
//! validation and path fencing with no side effects and yields a [`PreparedCall`],
//! and only a successful `PreparedCall` can reach `run`. Invalid JSON, an unknown
//! tool, a missing field, or a path that escapes the workspace all fail at
//! `prepare`, before any `tool.started` is recorded and before `run` is called.

pub mod fence;
pub mod fs;

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;

use serde_json::Value;

/// A boxed, `Send` future — the object-safe return shape for [`Tool::run`].
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The output of running a tool: `Ok` text, or an `Err` message that is fed back
/// to the model as a tool error so it can recover.
pub type ToolResult = Result<String, String>;

/// Shared, read-only context handed to every tool invocation.
///
/// PR2 carries only the canonicalized workspace root (the fence anchor). A
/// cancellation handle for long-running tools (`shell`) is deferred until a tool
/// that can actually block on it exists.
#[derive(Debug, Clone)]
pub struct ToolContext {
    pub workspace_root: PathBuf,
}

/// A validated, ready-to-run invocation. Only [`Tool::prepare`] can mint one, so
/// its existence certifies that arguments parsed and the path is inside the
/// workspace. PR2's tools all resolve to a single fenced path; this grows fields
/// (content, argv) when `edit`/`shell` arrive.
#[derive(Debug, Clone, PartialEq)]
pub struct PreparedCall {
    pub path: PathBuf,
}

/// One tool the agent can call.
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;

    /// Whether an invocation must clear the [`PermissionGate`](crate::permission::PermissionGate)
    /// before running. Read-only tools return `false` (auto-allowed); `edit`/`shell`
    /// will return `true`. Centralizing the policy here keeps the loop free of
    /// per-tool-name conditionals.
    fn requires_confirmation(&self) -> bool;

    /// Validate arguments and fence paths with no side effects. `Err` rejects the
    /// call before it starts.
    fn prepare(&self, ctx: &ToolContext, args: &Value) -> Result<PreparedCall, String>;

    /// A human summary of the prepared action, shown to the user and recorded as
    /// the ledger's `permission.requested` action. Only reached for tools that
    /// require confirmation.
    fn summarize(&self, prepared: &PreparedCall) -> String;

    /// Execute a prepared call. Reached only after `prepare` succeeded and (if
    /// required) permission was granted.
    fn run<'a>(
        &'a self,
        ctx: &'a ToolContext,
        prepared: &'a PreparedCall,
    ) -> BoxFuture<'a, ToolResult>;
}

/// The set of tools available to a session, keyed by name.
#[derive(Default)]
pub struct ToolRuntime {
    tools: HashMap<String, Box<dyn Tool>>,
}

impl ToolRuntime {
    pub fn new() -> Self {
        ToolRuntime::default()
    }

    /// A runtime with the built-in read-only tools (`read`, `list`).
    pub fn with_read_only() -> Self {
        let mut runtime = ToolRuntime::new();
        runtime.register(Box::new(fs::ReadTool));
        runtime.register(Box::new(fs::ListTool));
        runtime
    }

    pub fn register(&mut self, tool: Box<dyn Tool>) {
        self.tools.insert(tool.name().to_string(), tool);
    }

    pub fn get(&self, name: &str) -> Option<&dyn Tool> {
        self.tools.get(name).map(|boxed| boxed.as_ref())
    }
}
