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
//!
//! [`PreparedCall`] is an enum, one variant per built-in action. The variant *is*
//! the validated plan: it carries exactly the data `run` needs (a fenced path,
//! the replacement strings, the command line) and nothing else, so `run` cannot
//! re-derive a path or re-parse an argument. Only `prepare` mints a variant, and a
//! tool's `run` handles just its own; a variant it did not mint is an internal
//! bug, reported as an `Err`, never a panic (the core must not abort a turn).

pub mod edit;
pub mod fence;
pub mod fs;
pub mod shell;

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;

use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

/// A boxed, `Send` future — the object-safe return shape for [`Tool::run`].
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// The output of running a tool: `Ok` text, or an `Err` message that is fed back
/// to the model as a tool error so it can recover.
pub type ToolResult = Result<String, String>;

/// The `Err` a tool returns when it is handed a [`PreparedCall`] variant it did
/// not mint. Unreachable if the runtime is wired correctly (each tool's `prepare`
/// only produces its own variant), so this is a defensive internal-error string,
/// never a panic — the loop must survive it and keep the turn alive.
const MISMATCHED_CALL: &str = "internal: mismatched prepared call";

/// Shared, read-only context handed to every tool invocation.
///
/// Carries the canonicalized workspace root (the fence anchor) and a cancellation
/// handle. The token lets a long-running tool (`shell`) abort promptly when the
/// turn is interrupted; path-only tools ignore it.
#[derive(Debug, Clone)]
pub struct ToolContext {
    pub workspace_root: PathBuf,
    /// Fired when the turn is cancelled. `shell` selects on it to kill its process
    /// tree; the fast file tools finish before it could ever matter.
    pub cancel: CancellationToken,
}

/// A validated, ready-to-run invocation. Only [`Tool::prepare`] can mint one, so
/// its existence certifies that arguments parsed and (for the file tools) the path
/// is inside the workspace. One variant per built-in action; each carries exactly
/// what its `run` consumes.
#[derive(Debug, Clone, PartialEq)]
pub enum PreparedCall {
    /// `read`: a fenced, existing file or directory to read/list.
    Read { path: PathBuf },
    /// `edit`: a fenced, existing file plus the exact substring to replace.
    Edit {
        path: PathBuf,
        old: String,
        new: String,
    },
    /// `write`: a fenced target (new or overwrite) and the bytes to write.
    Write { path: PathBuf, content: String },
    /// `shell`: a command line to run under `/bin/sh -c`. Not path-fenced — a
    /// shell's reach is unbounded, so its boundary is the permission gate.
    Shell { command: String },
}

/// One tool the agent can call.
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;

    /// A one-line, model-facing description of what the tool does, adapted from the
    /// vendored prompt copy. Fed into the provider's function schema via
    /// [`ToolRuntime::schemas`].
    fn description(&self) -> &str;

    /// The JSON Schema for the tool's arguments object (the `parameters` field of
    /// an OpenAI function definition). An object schema with typed properties and
    /// a `required` list.
    fn parameters(&self) -> Value;

    /// Whether an invocation must clear the [`PermissionGate`](crate::permission::PermissionGate)
    /// before running. Read-only tools return `false` (auto-allowed); the
    /// write-side tools (`edit`/`write`/`shell`) return `true`. Centralizing the
    /// policy here keeps the loop free of per-tool-name conditionals.
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

    /// A runtime with all built-in tools: the read-only `read` and the write-side
    /// `edit`, `write`, and `shell`. `shell` runs on the default timeout.
    pub fn with_builtins() -> Self {
        let mut runtime = ToolRuntime::new();
        runtime.register(Box::new(fs::ReadTool));
        runtime.register(Box::new(edit::EditTool));
        runtime.register(Box::new(edit::WriteTool));
        runtime.register(Box::new(shell::ShellTool::new(
            shell::DEFAULT_SHELL_TIMEOUT,
        )));
        runtime
    }

    pub fn register(&mut self, tool: Box<dyn Tool>) {
        self.tools.insert(tool.name().to_string(), tool);
    }

    pub fn get(&self, name: &str) -> Option<&dyn Tool> {
        self.tools.get(name).map(|boxed| boxed.as_ref())
    }

    /// The registered tools as OpenAI function schemas, sorted by name for a
    /// deterministic request body. This is what the CLI feeds into
    /// [`crate::openai_compat::RequestConfig::tools`].
    pub fn schemas(&self) -> Vec<Value> {
        let mut schemas: Vec<Value> = self
            .tools
            .values()
            .map(|tool| {
                json!({
                    "type": "function",
                    "function": {
                        "name": tool.name(),
                        "description": tool.description(),
                        "parameters": tool.parameters(),
                    },
                })
            })
            .collect();
        schemas.sort_by(|left, right| {
            left["function"]["name"]
                .as_str()
                .cmp(&right["function"]["name"].as_str())
        });
        schemas
    }
}
