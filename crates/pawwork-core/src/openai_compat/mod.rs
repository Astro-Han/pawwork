//! A hand-written OpenAI-compatible streaming client for [`LlmClient`].
//!
//! No SDK: one `POST /chat/completions` with `stream: true`, parsed with our own
//! SSE decoder ([`stream`]) and folded into a [`ModelTurn`] ([`stream::TurnAccumulator`]).
//! Request shaping — including cancelled-call sanitation — lives in [`wire`]. The
//! same base_url/model/api_key seam serves any provider that speaks the OpenAI
//! wire (DeepSeek, national compatible endpoints); provider quirks that need more
//! than config land later.
//!
//! Scope note: retry/backoff on 429/5xx and idle-stall watchdogs
//! (`docs/architecture/2026-07-09-rust-agent-v0.md`, §5) are deliberately not
//! here yet — this PR proves incremental parsing and pairing against offline
//! fixtures. A dropped stream currently surfaces as one `Err`, not a reconnect.

mod stream;
pub mod wire;

pub use wire::{build_request_body, RequestConfig};

use std::future::Future;

use serde_json::Value;

use crate::llm::{ChatMessage, LlmClient, LlmError, ModelTurn};
use stream::{SseDecoder, TurnAccumulator};

/// Everything needed to reach one provider endpoint.
#[derive(Debug, Clone)]
pub struct OpenAiConfig {
    /// Base URL without a trailing `/chat/completions` (e.g. `https://api.deepseek.com`).
    pub base_url: String,
    pub model: String,
    /// The resolved secret. The client never reads the environment itself.
    pub api_key: String,
    /// The env var the key came from, used only to make a 401 message actionable.
    pub api_key_env: Option<String>,
    /// Pre-built tool JSON schemas the model may call; empty omits `tools`.
    pub tools: Vec<Value>,
    pub system_prompt: Option<String>,
}

/// A streaming OpenAI-compatible model client.
pub struct OpenAiClient {
    http: reqwest::Client,
    request: RequestConfig,
    /// `base_url` with any trailing slash trimmed.
    base_url: String,
    api_key: String,
    api_key_env: Option<String>,
}

impl OpenAiClient {
    pub fn new(config: OpenAiConfig) -> Result<Self, LlmError> {
        let http = reqwest::Client::builder()
            .build()
            .map_err(|err| LlmError::new(format!("failed to build HTTP client: {err}")))?;
        Ok(OpenAiClient {
            http,
            request: RequestConfig {
                model: config.model,
                tools: config.tools,
                system_prompt: config.system_prompt,
            },
            base_url: config.base_url.trim_end_matches('/').to_string(),
            api_key: config.api_key,
            api_key_env: config.api_key_env,
        })
    }
}

impl LlmClient for OpenAiClient {
    fn respond(
        &self,
        history: &[ChatMessage],
    ) -> impl Future<Output = Result<ModelTurn, LlmError>> + Send {
        // Build the request synchronously so nothing borrows `self` or `history`
        // across the await.
        let body = build_request_body(&self.request, history);
        let pending = self
            .http
            .post(format!("{}/chat/completions", self.base_url))
            .bearer_auth(&self.api_key)
            .header("content-type", "application/json")
            .header("accept", "text/event-stream")
            .body(body.to_string())
            .send();
        let api_key_env = self.api_key_env.clone();

        async move {
            let mut response = pending
                .await
                .map_err(|err| LlmError::new(format!("request failed: {err}")))?;
            let status = response.status();
            if !status.is_success() {
                let body = response.text().await.unwrap_or_default();
                return Err(status_error(status.as_u16(), api_key_env.as_deref(), &body));
            }

            let mut decoder = SseDecoder::new();
            let mut accumulator = TurnAccumulator::new();
            let mut frames = Vec::new();
            loop {
                let chunk = response
                    .chunk()
                    .await
                    .map_err(|err| LlmError::new(format!("stream read error: {err}")))?;
                match chunk {
                    Some(bytes) => {
                        decoder.push(&bytes, &mut frames);
                        for frame in frames.drain(..) {
                            accumulator.ingest(frame);
                        }
                    }
                    None => {
                        decoder.finish(&mut frames);
                        for frame in frames.drain(..) {
                            accumulator.ingest(frame);
                        }
                        break;
                    }
                }
            }
            accumulator.finish()
        }
    }
}

/// Turn a non-2xx status into an [`LlmError`], naming the key env var on 401 so a
/// misconfigured credential is self-diagnosing.
fn status_error(status: u16, api_key_env: Option<&str>, body: &str) -> LlmError {
    if status == 401 {
        let hint = api_key_env
            .map(|env| format!(" (check that {env} holds a valid key)"))
            .unwrap_or_default();
        return LlmError::new(format!("HTTP 401 unauthorized{hint}"));
    }
    // Bound the echoed body so a huge HTML error page cannot flood the message.
    let detail: String = body.trim().chars().take(500).collect();
    LlmError::new(format!("HTTP {status}: {detail}"))
}
