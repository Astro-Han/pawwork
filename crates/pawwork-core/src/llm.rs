//! The model boundary.
//!
//! [`LlmClient`] is the seam between the turn loop and whatever produces model
//! turns — a scripted [`MockLlmClient`] here, a real OpenAI-compatible SSE client
//! in a later PR. The trait is generic (never `dyn`): the loop holds exactly one
//! client, so a concrete type parameter is simpler than a boxed future and keeps
//! the `Send` bound legible at the definition rather than at a distant use site.
//!
//! Half-parsed tool calls are unrepresentable by contract: a client only ever
//! returns a [`ModelTurn`] whose `tool_calls` are fully parsed. A stream that
//! dies or is cancelled mid-flight resolves to `Err`/never resolves — the torn
//! buffer dies inside the client, so the loop has no "is this a half call?" branch
//! to get wrong.

use std::future::Future;

use crate::session::event::ToolCall;

/// One message in the in-memory chat history the loop feeds back to the model.
///
/// This is the wire/model view, distinct from the ledger's [`crate::session::event::EventKind`].
/// PR2 builds it live during a turn; reconstructing it from the ledger for
/// cross-session resume is deferred to the resume/CLI PR.
#[derive(Debug, Clone, PartialEq)]
pub enum ChatMessage {
    User(String),
    Assistant {
        text: String,
        tool_calls: Vec<ToolCall>,
    },
    /// The result fed back for one tool call — a real output, or a synthesized
    /// error when the call was rejected, denied, or cancelled before execution.
    Tool {
        call_id: String,
        content: String,
    },
}

/// A completed model turn: assistant text plus fully-parsed tool calls.
#[derive(Debug, Clone, PartialEq)]
pub struct ModelTurn {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
}

/// An unrecoverable model/transport error. Minimal in PR2 (mock only); the real
/// client will carry status/kind for backoff decisions.
#[derive(Debug, Clone, PartialEq)]
pub struct LlmError {
    pub message: String,
}

impl LlmError {
    pub fn new(message: impl Into<String>) -> Self {
        LlmError {
            message: message.into(),
        }
    }
}

/// The model boundary. One turn in, one turn out.
///
/// `respond`'s future is `Send` so the loop can run on a multi-thread runtime;
/// this is stated here rather than inferred at a spawn site far away.
pub trait LlmClient: Send + Sync {
    fn respond(
        &self,
        history: &[ChatMessage],
    ) -> impl Future<Output = Result<ModelTurn, LlmError>> + Send;
}

/// A scripted model for tests and CLI bring-up: pops one [`MockResponse`] per
/// call, in order, and records the history it was handed so tests can assert the
/// loop reconstructs the conversation correctly.
#[derive(Debug)]
pub struct MockLlmClient {
    script: std::sync::Mutex<std::collections::VecDeque<MockResponse>>,
    seen: std::sync::Mutex<Vec<Vec<ChatMessage>>>,
}

/// One scripted step.
#[derive(Debug, Clone)]
pub enum MockResponse {
    /// Return this turn (empty `tool_calls` ends the loop).
    Turn(ModelTurn),
    /// Return an error, exercising the loop's error path.
    Fail(LlmError),
    /// Never resolve, so the loop parks on the model await until cancelled — the
    /// only way to test mid-model interruption.
    HangUntilCancel,
}

impl MockLlmClient {
    pub fn new(script: Vec<MockResponse>) -> Self {
        MockLlmClient {
            script: std::sync::Mutex::new(script.into()),
            seen: std::sync::Mutex::new(Vec::new()),
        }
    }

    /// Convenience: a one-shot text reply with no tool calls.
    pub fn once_text(text: impl Into<String>) -> Self {
        MockLlmClient::new(vec![MockResponse::Turn(ModelTurn {
            text: text.into(),
            tool_calls: Vec::new(),
        })])
    }

    /// The histories handed to `respond`, in call order — one entry per model
    /// round.
    pub fn seen_histories(&self) -> Vec<Vec<ChatMessage>> {
        self.seen.lock().expect("mock seen lock").clone()
    }
}

impl LlmClient for MockLlmClient {
    fn respond(
        &self,
        history: &[ChatMessage],
    ) -> impl Future<Output = Result<ModelTurn, LlmError>> + Send {
        // Record and pop synchronously; do not hold either lock across the await.
        self.seen
            .lock()
            .expect("mock seen lock")
            .push(history.to_vec());
        let next = self.script.lock().expect("mock script lock").pop_front();
        async move {
            match next {
                Some(MockResponse::Turn(turn)) => Ok(turn),
                Some(MockResponse::Fail(err)) => Err(err),
                Some(MockResponse::HangUntilCancel) => {
                    std::future::pending::<Result<ModelTurn, LlmError>>().await
                }
                // Exhausted script: end the turn with an empty reply rather than
                // hang, so a test that under-scripts fails loudly on assertions
                // instead of deadlocking.
                None => Ok(ModelTurn {
                    text: String::new(),
                    tool_calls: Vec::new(),
                }),
            }
        }
    }
}
