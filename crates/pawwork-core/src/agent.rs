//! The turn loop.
//!
//! [`Agent`] owns the session store, the model client, the tool runtime, and the
//! permission gate, and drives one user turn to completion or interruption. It is
//! the single orchestrator: tools and the client never write the ledger, and the
//! loop never touches stdin. `run_turn` appends every ledger event and mirrors it
//! onto an [`AgentEvent`] channel — appending first, emitting second, so the
//! ledger stays the source of truth and the channel is only a live view.
//!
//! Interruption is cooperative via a [`CancellationToken`]. It is observed at
//! four points: at the top of each model round, around the model call, around a
//! permission wait, and before each tool in a batch. The finalizing
//! `turn.interrupted` append is itself never cancellable. "Never run a
//! half-parsed call" needs no code here: the [`LlmClient`] contract only yields
//! fully-parsed `tool_calls`, and [`crate::tool::Tool::prepare`] rejects a
//! malformed or out-of-workspace call before any `tool.started`.

use std::io;
use std::path::Path;
use std::path::PathBuf;

use serde_json::Value;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::llm::{ChatMessage, LlmClient};
use crate::permission::{PermissionGate, PermissionRequest};
use crate::session::event::{EventKind, LedgerEvent, ToolCall};
use crate::session::store::SessionStore;
use crate::tool::{ToolContext, ToolRuntime};

/// A wire event, emitted live as the turn runs.
///
/// Deliberately distinct from the ledger's [`EventKind`]: the ledger is the
/// durable projection, while this stream can carry things that are never
/// persisted. PR2 only mirrors ledger events; a token-level `ModelDelta` variant
/// (streaming, not persisted) lands with the SSE client, without touching the
/// on-disk schema.
#[derive(Debug, Clone, PartialEq)]
pub enum AgentEvent {
    Ledger(LedgerEvent),
}

/// How a turn ended.
#[derive(Debug, Clone, PartialEq)]
pub enum TurnOutcome {
    Completed,
    Interrupted { reason: String },
}

impl TurnOutcome {
    fn interrupted(reason: impl Into<String>) -> Self {
        TurnOutcome::Interrupted {
            reason: reason.into(),
        }
    }
}

/// Default cap on model rounds within a single turn. A runaway or adversarial
/// model that keeps returning tool calls would otherwise loop forever, growing
/// the ledger and context without end; this bounds one turn to a finite number
/// of model requests. Generous enough that real multi-step tasks are unaffected.
const DEFAULT_MAX_MODEL_ROUNDS: usize = 64;

/// Internal per-call control flow.
enum CallFlow {
    /// Move on to the next tool call (the result, error, or denial was recorded).
    Continue,
    /// The turn was cancelled mid-call; the caller must finalize.
    Interrupted(String),
}

/// The UI-less agent: one session, one turn at a time.
pub struct Agent<L: LlmClient, G: PermissionGate> {
    store: SessionStore,
    client: L,
    runtime: ToolRuntime,
    gate: G,
    workspace_root: PathBuf,
    history: Vec<ChatMessage>,
    max_model_rounds: usize,
}

impl<L: LlmClient, G: PermissionGate> Agent<L, G> {
    /// Wire up an agent over an open session store. `workspace_root` is
    /// canonicalized once here so the tool fence can compare by component.
    pub fn new(
        store: SessionStore,
        client: L,
        runtime: ToolRuntime,
        gate: G,
        workspace_root: &Path,
    ) -> io::Result<Self> {
        let workspace_root = workspace_root.canonicalize()?;
        Ok(Agent {
            store,
            client,
            runtime,
            gate,
            workspace_root,
            history: Vec::new(),
            max_model_rounds: DEFAULT_MAX_MODEL_ROUNDS,
        })
    }

    /// Override the per-turn model-round budget (see [`DEFAULT_MAX_MODEL_ROUNDS`]).
    pub fn with_max_model_rounds(mut self, max_model_rounds: usize) -> Self {
        self.max_model_rounds = max_model_rounds;
        self
    }

    /// Run one user turn: record the message, then loop model rounds — executing
    /// any tool calls through the permission gate and feeding results back — until
    /// the model replies with no tool calls (completed) or the turn is cancelled
    /// or errors (interrupted).
    pub async fn run_turn(
        &mut self,
        user_text: &str,
        cancel: &CancellationToken,
        tx: &mpsc::UnboundedSender<AgentEvent>,
    ) -> io::Result<TurnOutcome> {
        // Cancelled before anything is recorded: there is no turn to interrupt.
        if cancel.is_cancelled() {
            return Ok(TurnOutcome::interrupted("cancelled before start"));
        }

        let turn_id = new_id();
        emit(
            &mut self.store,
            tx,
            &turn_id,
            EventKind::UserMessage {
                text: user_text.to_string(),
            },
        )?;
        self.history.push(ChatMessage::User(user_text.to_string()));

        let mut round = 0usize;
        loop {
            if cancel.is_cancelled() {
                return self.finalize_interrupted(&turn_id, "cancelled", tx);
            }

            // Runaway guard: a model that keeps returning tool calls must not loop
            // forever. Record an error and interrupt once the round budget is spent.
            round += 1;
            if round > self.max_model_rounds {
                let reason = format!(
                    "budget exceeded: max model rounds ({})",
                    self.max_model_rounds
                );
                emit(
                    &mut self.store,
                    tx,
                    &turn_id,
                    EventKind::Error {
                        message: reason.clone(),
                    },
                )?;
                return self.finalize_interrupted(&turn_id, &reason, tx);
            }

            // Ask the model, cancellable. `None` means the token fired first.
            let responded = cancel
                .run_until_cancelled(self.client.respond(&self.history))
                .await;
            let turn = match responded {
                None => return self.finalize_interrupted(&turn_id, "cancelled", tx),
                Some(Err(err)) => {
                    emit(
                        &mut self.store,
                        tx,
                        &turn_id,
                        EventKind::Error {
                            message: err.message.clone(),
                        },
                    )?;
                    let reason = format!("llm error: {}", err.message);
                    return self.finalize_interrupted(&turn_id, &reason, tx);
                }
                Some(Ok(turn)) => turn,
            };

            emit(
                &mut self.store,
                tx,
                &turn_id,
                EventKind::ModelMessage {
                    text: turn.text.clone(),
                    tool_calls: turn.tool_calls.clone(),
                },
            )?;
            self.history.push(ChatMessage::Assistant {
                text: turn.text.clone(),
                tool_calls: turn.tool_calls.clone(),
            });

            if turn.tool_calls.is_empty() {
                emit(&mut self.store, tx, &turn_id, EventKind::TurnCompleted)?;
                return Ok(TurnOutcome::Completed);
            }

            let ctx = ToolContext {
                workspace_root: self.workspace_root.clone(),
            };
            for call in &turn.tool_calls {
                if cancel.is_cancelled() {
                    return self.finalize_interrupted(&turn_id, "cancelled", tx);
                }
                match self.execute_call(call, &ctx, cancel, tx, &turn_id).await? {
                    CallFlow::Continue => {}
                    CallFlow::Interrupted(reason) => {
                        return self.finalize_interrupted(&turn_id, &reason, tx);
                    }
                }
            }
            // All tool results are in history; loop back for another model round.
        }
    }

    /// Run one tool call: reject-before-start on any validation failure, gate on
    /// confirmation, then execute. Every branch records a `tool.finished` (the
    /// result fed back to the model), but `tool.started` is recorded only when the
    /// tool body actually runs — so a lone `tool.finished` marks a call rejected
    /// or denied before execution.
    async fn execute_call(
        &mut self,
        call: &ToolCall,
        ctx: &ToolContext,
        cancel: &CancellationToken,
        tx: &mpsc::UnboundedSender<AgentEvent>,
        turn_id: &str,
    ) -> io::Result<CallFlow> {
        let call_id = call.call_id.clone();

        let tool = match self.runtime.get(&call.name) {
            Some(tool) => tool,
            None => {
                finish_call(
                    &mut self.store,
                    &mut self.history,
                    tx,
                    turn_id,
                    &call_id,
                    false,
                    format!("unknown tool '{}'", call.name),
                )?;
                return Ok(CallFlow::Continue);
            }
        };

        let args: Value = match serde_json::from_str(&call.arguments) {
            Ok(value) => value,
            Err(err) => {
                finish_call(
                    &mut self.store,
                    &mut self.history,
                    tx,
                    turn_id,
                    &call_id,
                    false,
                    format!("invalid JSON arguments: {err}"),
                )?;
                return Ok(CallFlow::Continue);
            }
        };

        let prepared = match tool.prepare(ctx, &args) {
            Ok(prepared) => prepared,
            Err(reason) => {
                finish_call(
                    &mut self.store,
                    &mut self.history,
                    tx,
                    turn_id,
                    &call_id,
                    false,
                    reason,
                )?;
                return Ok(CallFlow::Continue);
            }
        };

        // Confirmation, only for tools that require it. Auto-allowed tools skip
        // the gate entirely and record no permission events (avoids two ledger
        // lines per read).
        if tool.requires_confirmation() {
            let summary = tool.summarize(&prepared);
            emit(
                &mut self.store,
                tx,
                turn_id,
                EventKind::PermissionRequested {
                    call_id: call_id.clone(),
                    action: summary.clone(),
                },
            )?;
            let request = PermissionRequest {
                tool_name: call.name.clone(),
                summary,
            };
            let allowed = match cancel.run_until_cancelled(self.gate.decide(&request)).await {
                Some(allowed) => allowed,
                None => return Ok(CallFlow::Interrupted("cancelled".to_string())),
            };
            emit(
                &mut self.store,
                tx,
                turn_id,
                EventKind::PermissionDecided {
                    call_id: call_id.clone(),
                    allowed,
                },
            )?;
            if !allowed {
                finish_call(
                    &mut self.store,
                    &mut self.history,
                    tx,
                    turn_id,
                    &call_id,
                    false,
                    "permission denied".to_string(),
                )?;
                return Ok(CallFlow::Continue);
            }
        }

        emit(
            &mut self.store,
            tx,
            turn_id,
            EventKind::ToolStarted {
                call_id: call_id.clone(),
                name: call.name.clone(),
            },
        )?;
        let (ok, output) = match tool.run(ctx, &prepared).await {
            Ok(output) => (true, output),
            Err(err) => (false, err),
        };
        finish_call(
            &mut self.store,
            &mut self.history,
            tx,
            turn_id,
            &call_id,
            ok,
            output,
        )?;
        Ok(CallFlow::Continue)
    }

    /// Record `turn.interrupted` and return. Not cancellable: interruption
    /// cleanup must always run to completion.
    fn finalize_interrupted(
        &mut self,
        turn_id: &str,
        reason: &str,
        tx: &mpsc::UnboundedSender<AgentEvent>,
    ) -> io::Result<TurnOutcome> {
        emit(
            &mut self.store,
            tx,
            turn_id,
            EventKind::TurnInterrupted {
                reason: reason.to_string(),
            },
        )?;
        Ok(TurnOutcome::interrupted(reason))
    }
}

/// Append one ledger event, then mirror it onto the wire stream. Append first so
/// the ledger is authoritative; a dropped receiver is ignored, not an error.
fn emit(
    store: &mut SessionStore,
    tx: &mpsc::UnboundedSender<AgentEvent>,
    turn_id: &str,
    kind: EventKind,
) -> io::Result<()> {
    let event = store.append(Some(turn_id.to_string()), kind)?;
    let _ = tx.send(AgentEvent::Ledger(event));
    Ok(())
}

/// Record a `tool.finished` and push its output into history as the tool result
/// fed back to the model — for a real result, a rejection, or a denial.
fn finish_call(
    store: &mut SessionStore,
    history: &mut Vec<ChatMessage>,
    tx: &mpsc::UnboundedSender<AgentEvent>,
    turn_id: &str,
    call_id: &str,
    ok: bool,
    output: String,
) -> io::Result<()> {
    let event = store.append(
        Some(turn_id.to_string()),
        EventKind::ToolFinished {
            call_id: call_id.to_string(),
            ok,
            output: output.clone(),
        },
    )?;
    let _ = tx.send(AgentEvent::Ledger(event));
    history.push(ChatMessage::Tool {
        call_id: call_id.to_string(),
        content: output,
    });
    Ok(())
}

fn new_id() -> String {
    Uuid::new_v4().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    use crate::llm::{LlmError, MockLlmClient, MockResponse, ModelTurn};
    use crate::session::store::project;
    use crate::tool::{BoxFuture, PreparedCall, Tool, ToolResult};

    // --- Fixtures --------------------------------------------------------

    struct TempDirs {
        base: PathBuf,
        ledger_root: PathBuf,
        workspace: PathBuf,
    }

    impl TempDirs {
        fn new() -> Self {
            let base = std::env::temp_dir().join(format!("pawwork-agent-{}", Uuid::new_v4()));
            let ledger_root = base.join("ledger");
            let workspace = base.join("workspace");
            std::fs::create_dir_all(&ledger_root).unwrap();
            std::fs::create_dir_all(&workspace).unwrap();
            TempDirs {
                base,
                ledger_root,
                workspace,
            }
        }

        fn write(&self, name: &str, contents: &[u8]) {
            std::fs::write(self.workspace.join(name), contents).unwrap();
        }
    }

    impl Drop for TempDirs {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.base).ok();
        }
    }

    fn build<L: LlmClient, G: PermissionGate>(
        client: L,
        gate: G,
        runtime: ToolRuntime,
        dirs: &TempDirs,
    ) -> (Agent<L, G>, PathBuf) {
        let store =
            SessionStore::create(&dirs.ledger_root, dirs.workspace.to_str().unwrap()).unwrap();
        let session_dir = store.dir().to_path_buf();
        let agent = Agent::new(store, client, runtime, gate, &dirs.workspace).unwrap();
        (agent, session_dir)
    }

    fn call(call_id: &str, name: &str, arguments: &str) -> ToolCall {
        ToolCall {
            call_id: call_id.to_string(),
            name: name.to_string(),
            arguments: arguments.to_string(),
        }
    }

    fn turn_with(calls: Vec<ToolCall>) -> MockResponse {
        MockResponse::Turn(ModelTurn {
            text: String::new(),
            tool_calls: calls,
        })
    }

    fn done() -> MockResponse {
        MockResponse::Turn(ModelTurn {
            text: "done".to_string(),
            tool_calls: Vec::new(),
        })
    }

    fn channel() -> (
        mpsc::UnboundedSender<AgentEvent>,
        mpsc::UnboundedReceiver<AgentEvent>,
    ) {
        mpsc::unbounded_channel()
    }

    fn kinds(events: &[LedgerEvent]) -> Vec<&EventKind> {
        events.iter().map(|event| &event.kind).collect()
    }

    // --- Test doubles ----------------------------------------------------

    struct AllowGate;
    impl PermissionGate for AllowGate {
        async fn decide(&self, _req: &PermissionRequest) -> bool {
            true
        }
    }

    struct DenyGate;
    impl PermissionGate for DenyGate {
        async fn decide(&self, _req: &PermissionRequest) -> bool {
            false
        }
    }

    struct HangGate;
    impl PermissionGate for HangGate {
        async fn decide(&self, _req: &PermissionRequest) -> bool {
            std::future::pending::<bool>().await
        }
    }

    /// A tool that requires confirmation, so tests can exercise the gate path
    /// without a real side-effecting tool (which lands with `edit`/`shell`).
    struct ConfirmTool;
    impl Tool for ConfirmTool {
        fn name(&self) -> &str {
            "danger"
        }
        fn requires_confirmation(&self) -> bool {
            true
        }
        fn prepare(&self, ctx: &ToolContext, _args: &Value) -> Result<PreparedCall, String> {
            Ok(PreparedCall {
                path: ctx.workspace_root.clone(),
            })
        }
        fn summarize(&self, _prepared: &PreparedCall) -> String {
            "do the dangerous thing".to_string()
        }
        fn run<'a>(
            &'a self,
            _ctx: &'a ToolContext,
            _prepared: &'a PreparedCall,
        ) -> BoxFuture<'a, ToolResult> {
            Box::pin(async { Ok("did the thing".to_string()) })
        }
    }

    fn confirm_runtime() -> ToolRuntime {
        let mut runtime = ToolRuntime::new();
        runtime.register(Box::new(ConfirmTool));
        runtime
    }

    // --- Tests -----------------------------------------------------------

    #[tokio::test(flavor = "multi_thread")]
    async fn plain_text_turn_completes() {
        let dirs = TempDirs::new();
        let (mut agent, session_dir) = build(
            MockLlmClient::once_text("hi there"),
            AllowGate,
            ToolRuntime::with_read_only(),
            &dirs,
        );
        let cancel = CancellationToken::new();
        let (tx, _rx) = channel();
        let outcome = agent.run_turn("hello", &cancel, &tx).await.unwrap();
        assert_eq!(outcome, TurnOutcome::Completed);
        let events = project(&session_dir).unwrap();
        assert!(matches!(
            kinds(&events).as_slice(),
            [
                EventKind::SessionCreated { .. },
                EventKind::UserMessage { .. },
                EventKind::ModelMessage { .. },
                EventKind::TurnCompleted,
            ]
        ));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn channel_mirrors_appended_events_in_order() {
        let dirs = TempDirs::new();
        let (mut agent, session_dir) = build(
            MockLlmClient::once_text("hi"),
            AllowGate,
            ToolRuntime::with_read_only(),
            &dirs,
        );
        let cancel = CancellationToken::new();
        let (tx, mut rx) = channel();
        agent.run_turn("hello", &cancel, &tx).await.unwrap();
        drop(tx);
        let mut streamed = Vec::new();
        while let Ok(AgentEvent::Ledger(event)) = rx.try_recv() {
            streamed.push(event);
        }
        let ledger = project(&session_dir).unwrap();
        // Everything after the pre-run session.created is mirrored, in order.
        assert_eq!(streamed, ledger[1..].to_vec());
        assert!(matches!(ledger[0].kind, EventKind::SessionCreated { .. }));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn read_tool_round_trips_result_into_history() {
        let dirs = TempDirs::new();
        dirs.write("a.txt", b"hello from file");
        let (mut agent, session_dir) = build(
            MockLlmClient::new(vec![
                turn_with(vec![call("c1", "read", r#"{"path":"a.txt"}"#)]),
                done(),
            ]),
            AllowGate,
            ToolRuntime::with_read_only(),
            &dirs,
        );
        let cancel = CancellationToken::new();
        let (tx, _rx) = channel();
        let outcome = agent.run_turn("read it", &cancel, &tx).await.unwrap();
        assert_eq!(outcome, TurnOutcome::Completed);

        let events = project(&session_dir).unwrap();
        // read is auto-allowed: no permission events.
        assert!(!events
            .iter()
            .any(|e| matches!(e.kind, EventKind::PermissionRequested { .. })));
        let finished = events
            .iter()
            .find_map(|e| match &e.kind {
                EventKind::ToolFinished { ok, output, .. } => Some((*ok, output.clone())),
                _ => None,
            })
            .unwrap();
        assert_eq!(finished, (true, "hello from file".to_string()));
        assert!(events
            .iter()
            .any(|e| matches!(e.kind, EventKind::ToolStarted { .. })));

        // The second model round saw the tool result in its history.
        let seen = agent.client.seen_histories();
        assert_eq!(seen.len(), 2, "two model rounds");
        assert!(seen[1].iter().any(
            |m| matches!(m, ChatMessage::Tool { content, .. } if content == "hello from file")
        ));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn unknown_tool_is_rejected_without_started() {
        let dirs = TempDirs::new();
        let (mut agent, session_dir) = build(
            MockLlmClient::new(vec![turn_with(vec![call("c1", "nope", "{}")]), done()]),
            AllowGate,
            ToolRuntime::with_read_only(),
            &dirs,
        );
        let cancel = CancellationToken::new();
        let (tx, _rx) = channel();
        let outcome = agent.run_turn("go", &cancel, &tx).await.unwrap();
        assert_eq!(
            outcome,
            TurnOutcome::Completed,
            "loop recovers via synthetic error"
        );
        let events = project(&session_dir).unwrap();
        assert!(
            !events
                .iter()
                .any(|e| matches!(e.kind, EventKind::ToolStarted { .. })),
            "a rejected call must not record tool.started"
        );
        let (ok, output) = events
            .iter()
            .find_map(|e| match &e.kind {
                EventKind::ToolFinished { ok, output, .. } => Some((*ok, output.clone())),
                _ => None,
            })
            .unwrap();
        assert!(!ok);
        assert!(output.contains("unknown tool"), "got: {output}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn invalid_json_arguments_rejected_without_started() {
        let dirs = TempDirs::new();
        let (mut agent, session_dir) = build(
            MockLlmClient::new(vec![
                turn_with(vec![call("c1", "read", "{not json")]),
                done(),
            ]),
            AllowGate,
            ToolRuntime::with_read_only(),
            &dirs,
        );
        let cancel = CancellationToken::new();
        let (tx, _rx) = channel();
        agent.run_turn("go", &cancel, &tx).await.unwrap();
        let events = project(&session_dir).unwrap();
        assert!(!events
            .iter()
            .any(|e| matches!(e.kind, EventKind::ToolStarted { .. })));
        assert!(events.iter().any(|e| matches!(
            &e.kind,
            EventKind::ToolFinished { ok: false, output, .. } if output.contains("invalid JSON")
        )));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn path_escape_rejected_without_started() {
        let dirs = TempDirs::new();
        let (mut agent, session_dir) = build(
            MockLlmClient::new(vec![
                turn_with(vec![call("c1", "read", r#"{"path":"/etc/hosts"}"#)]),
                done(),
            ]),
            AllowGate,
            ToolRuntime::with_read_only(),
            &dirs,
        );
        let cancel = CancellationToken::new();
        let (tx, _rx) = channel();
        agent.run_turn("go", &cancel, &tx).await.unwrap();
        let events = project(&session_dir).unwrap();
        assert!(!events
            .iter()
            .any(|e| matches!(e.kind, EventKind::ToolStarted { .. })));
        assert!(events.iter().any(|e| matches!(
            &e.kind,
            EventKind::ToolFinished { ok: false, output, .. } if output.contains("escapes")
        )));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn confirmed_tool_records_permission_then_runs() {
        let dirs = TempDirs::new();
        let (mut agent, session_dir) = build(
            MockLlmClient::new(vec![turn_with(vec![call("c1", "danger", "{}")]), done()]),
            AllowGate,
            confirm_runtime(),
            &dirs,
        );
        let cancel = CancellationToken::new();
        let (tx, _rx) = channel();
        let outcome = agent.run_turn("do it", &cancel, &tx).await.unwrap();
        assert_eq!(outcome, TurnOutcome::Completed);
        let events = project(&session_dir).unwrap();
        let seq: Vec<&EventKind> = events
            .iter()
            .map(|e| &e.kind)
            .filter(|k| {
                matches!(
                    k,
                    EventKind::PermissionRequested { .. }
                        | EventKind::PermissionDecided { .. }
                        | EventKind::ToolStarted { .. }
                        | EventKind::ToolFinished { .. }
                )
            })
            .collect();
        assert!(matches!(
            seq.as_slice(),
            [
                EventKind::PermissionRequested { .. },
                EventKind::PermissionDecided { allowed: true, .. },
                EventKind::ToolStarted { .. },
                EventKind::ToolFinished { ok: true, .. },
            ]
        ));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn denied_tool_synthesizes_error_and_continues() {
        let dirs = TempDirs::new();
        let (mut agent, session_dir) = build(
            MockLlmClient::new(vec![turn_with(vec![call("c1", "danger", "{}")]), done()]),
            DenyGate,
            confirm_runtime(),
            &dirs,
        );
        let cancel = CancellationToken::new();
        let (tx, _rx) = channel();
        let outcome = agent.run_turn("do it", &cancel, &tx).await.unwrap();
        assert_eq!(
            outcome,
            TurnOutcome::Completed,
            "denial is not interruption"
        );
        let events = project(&session_dir).unwrap();
        assert!(events
            .iter()
            .any(|e| matches!(e.kind, EventKind::PermissionDecided { allowed: false, .. })));
        assert!(
            !events
                .iter()
                .any(|e| matches!(e.kind, EventKind::ToolStarted { .. })),
            "denied before start"
        );
        assert!(events.iter().any(|e| matches!(
            &e.kind,
            EventKind::ToolFinished { ok: false, output, .. } if output.contains("denied")
        )));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cancelled_before_start_records_nothing() {
        let dirs = TempDirs::new();
        let (mut agent, session_dir) = build(
            MockLlmClient::once_text("hi"),
            AllowGate,
            ToolRuntime::with_read_only(),
            &dirs,
        );
        let cancel = CancellationToken::new();
        cancel.cancel();
        let (tx, _rx) = channel();
        let outcome = agent.run_turn("hello", &cancel, &tx).await.unwrap();
        assert!(matches!(outcome, TurnOutcome::Interrupted { .. }));
        let events = project(&session_dir).unwrap();
        // Only the pre-run session.created; the turn never began.
        assert_eq!(
            kinds(&events),
            vec![&EventKind::SessionCreated {
                workspace: dirs.workspace.to_str().unwrap().to_string()
            }]
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cancel_during_model_writes_interrupted() {
        let dirs = TempDirs::new();
        let (mut agent, session_dir) = build(
            MockLlmClient::new(vec![MockResponse::HangUntilCancel]),
            AllowGate,
            ToolRuntime::with_read_only(),
            &dirs,
        );
        let cancel = CancellationToken::new();
        let (tx, mut rx) = channel();
        let canceller = {
            let cancel = cancel.clone();
            tokio::spawn(async move {
                // Cancel once the user message has been emitted, so the loop is
                // parked on the (hanging) model call.
                while let Some(AgentEvent::Ledger(event)) = rx.recv().await {
                    if matches!(event.kind, EventKind::UserMessage { .. }) {
                        cancel.cancel();
                        break;
                    }
                }
            })
        };
        let outcome = agent.run_turn("hello", &cancel, &tx).await.unwrap();
        canceller.await.unwrap();
        assert!(matches!(outcome, TurnOutcome::Interrupted { .. }));
        let events = project(&session_dir).unwrap();
        assert!(events
            .iter()
            .any(|e| matches!(e.kind, EventKind::UserMessage { .. })));
        assert!(events
            .iter()
            .any(|e| matches!(e.kind, EventKind::TurnInterrupted { .. })));
        assert!(
            !events
                .iter()
                .any(|e| matches!(e.kind, EventKind::ModelMessage { .. })),
            "model never produced a message"
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cancel_during_permission_wait_writes_interrupted() {
        let dirs = TempDirs::new();
        let (mut agent, session_dir) = build(
            MockLlmClient::new(vec![turn_with(vec![call("c1", "danger", "{}")])]),
            HangGate,
            confirm_runtime(),
            &dirs,
        );
        let cancel = CancellationToken::new();
        let (tx, mut rx) = channel();
        let canceller = {
            let cancel = cancel.clone();
            tokio::spawn(async move {
                while let Some(AgentEvent::Ledger(event)) = rx.recv().await {
                    if matches!(event.kind, EventKind::PermissionRequested { .. }) {
                        cancel.cancel();
                        break;
                    }
                }
            })
        };
        let outcome = agent.run_turn("do it", &cancel, &tx).await.unwrap();
        canceller.await.unwrap();
        assert!(matches!(outcome, TurnOutcome::Interrupted { .. }));
        let events = project(&session_dir).unwrap();
        assert!(events
            .iter()
            .any(|e| matches!(e.kind, EventKind::PermissionRequested { .. })));
        assert!(
            !events
                .iter()
                .any(|e| matches!(e.kind, EventKind::PermissionDecided { .. })),
            "cancelled before a decision"
        );
        assert!(
            !events
                .iter()
                .any(|e| matches!(e.kind, EventKind::ToolStarted { .. })),
            "cancelled before the tool ran"
        );
        assert!(events
            .iter()
            .any(|e| matches!(e.kind, EventKind::TurnInterrupted { .. })));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn llm_error_records_error_then_interrupts() {
        let dirs = TempDirs::new();
        let (mut agent, session_dir) = build(
            MockLlmClient::new(vec![MockResponse::Fail(LlmError::new("boom"))]),
            AllowGate,
            ToolRuntime::with_read_only(),
            &dirs,
        );
        let cancel = CancellationToken::new();
        let (tx, _rx) = channel();
        let outcome = agent.run_turn("hello", &cancel, &tx).await.unwrap();
        match outcome {
            TurnOutcome::Interrupted { reason } => {
                assert!(reason.contains("boom"), "got: {reason}")
            }
            other => panic!("expected interrupted, got {other:?}"),
        }
        let events = project(&session_dir).unwrap();
        assert!(events.iter().any(|e| matches!(
            &e.kind,
            EventKind::Error { message } if message == "boom"
        )));
        assert!(events
            .iter()
            .any(|e| matches!(e.kind, EventKind::TurnInterrupted { .. })));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn model_round_budget_interrupts_a_runaway_loop() {
        let dirs = TempDirs::new();
        dirs.write("a.txt", b"x");
        // A model that keeps asking for a tool every round would loop forever.
        let (agent, session_dir) = build(
            MockLlmClient::new(vec![
                turn_with(vec![call("c1", "read", r#"{"path":"a.txt"}"#)]),
                turn_with(vec![call("c2", "read", r#"{"path":"a.txt"}"#)]),
                turn_with(vec![call("c3", "read", r#"{"path":"a.txt"}"#)]),
            ]),
            AllowGate,
            ToolRuntime::with_read_only(),
            &dirs,
        );
        let mut agent = agent.with_max_model_rounds(2);
        let cancel = CancellationToken::new();
        let (tx, _rx) = channel();
        let outcome = agent.run_turn("loop forever", &cancel, &tx).await.unwrap();
        match outcome {
            TurnOutcome::Interrupted { reason } => {
                assert!(reason.contains("budget"), "got: {reason}")
            }
            other => panic!("expected budget interruption, got {other:?}"),
        }
        let events = project(&session_dir).unwrap();
        let rounds = events
            .iter()
            .filter(|e| matches!(e.kind, EventKind::ModelMessage { .. }))
            .count();
        assert_eq!(
            rounds, 2,
            "budget stops after exactly max_model_rounds calls"
        );
        assert!(events.iter().any(|e| matches!(
            &e.kind,
            EventKind::Error { message } if message.contains("budget")
        )));
        assert!(events
            .iter()
            .any(|e| matches!(e.kind, EventKind::TurnInterrupted { .. })));
    }
}
