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
///
/// `Debug` is hand-written, not derived: `api_key` is a plaintext secret, and a
/// derived `Debug` would print it verbatim the moment this config lands in a log
/// line or error context (provider/endpoint/401 troubleshooting is exactly when
/// that happens). The impl redacts it.
#[derive(Clone)]
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

impl std::fmt::Debug for OpenAiConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never render the key itself; show only whether one is set, so debugging
        // a missing/empty credential stays possible without leaking the secret.
        let api_key = if self.api_key.is_empty() {
            "<unset>"
        } else {
            "<redacted>"
        };
        f.debug_struct("OpenAiConfig")
            .field("base_url", &self.base_url)
            .field("model", &self.model)
            .field("api_key", &api_key)
            .field("api_key_env", &self.api_key_env)
            .field("tools", &self.tools)
            .field("system_prompt", &self.system_prompt)
            .finish()
    }
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
                let body = read_capped_error_body(&mut response).await;
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

/// Cap on how much of a non-2xx response body the client reads. We only ever echo
/// a short truncated summary, so a pathological endpoint — a wrong base_url, or a
/// proxy returning a huge HTML error page — must not make the client buffer an
/// unbounded body just to drop nearly all of it.
const ERROR_BODY_CAP: usize = 8 * 1024;

/// Read at most [`ERROR_BODY_CAP`] bytes of an error response, then stop draining.
/// Reuses the same chunked read as the success stream, so a giant error body is
/// bounded the same way a giant stream would be. Only the remaining capacity of a
/// chunk is copied — a single huge chunk cannot push the buffer past the cap — so
/// the "at most 8 KiB" bound holds even at the chunk boundary. A read error
/// mid-body just ends the read early: a truncated detail beats none.
async fn read_capped_error_body(response: &mut reqwest::Response) -> String {
    let mut buf: Vec<u8> = Vec::new();
    while buf.len() < ERROR_BODY_CAP {
        match response.chunk().await {
            Ok(Some(bytes)) => {
                let remaining = ERROR_BODY_CAP - buf.len();
                if bytes.len() <= remaining {
                    buf.extend_from_slice(&bytes);
                } else {
                    buf.extend_from_slice(&bytes[..remaining]);
                    break;
                }
            }
            Ok(None) | Err(_) => break,
        }
    }
    String::from_utf8_lossy(&buf).into_owned()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_redacts_the_api_key() {
        let config = OpenAiConfig {
            base_url: "https://api.example.com".to_string(),
            model: "m".to_string(),
            api_key: "sk-super-secret-value".to_string(),
            api_key_env: Some("EXAMPLE_API_KEY".to_string()),
            tools: Vec::new(),
            system_prompt: None,
        };
        let rendered = format!("{config:?}");
        assert!(
            !rendered.contains("sk-super-secret-value"),
            "the secret must never appear in Debug output: {rendered}"
        );
        assert!(rendered.contains("<redacted>"));
        // The non-secret env var name stays visible, so config is still debuggable.
        assert!(rendered.contains("EXAMPLE_API_KEY"));
    }

    #[test]
    fn debug_marks_an_unset_key() {
        let config = OpenAiConfig {
            base_url: "https://api.example.com".to_string(),
            model: "m".to_string(),
            api_key: String::new(),
            api_key_env: None,
            tools: Vec::new(),
            system_prompt: None,
        };
        assert!(format!("{config:?}").contains("<unset>"));
    }
}
