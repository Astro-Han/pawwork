//! Inbound SSE parsing: raw bytes → one [`ModelTurn`].
//!
//! Two sans-io pieces the real client and the offline fixtures share. [`SseDecoder`]
//! is a push parser: bytes in, complete SSE frames out, buffering any partial
//! trailing line — so a chunked HTTP body split at arbitrary byte boundaries
//! yields the same frames as one contiguous buffer. [`TurnAccumulator`] folds
//! those frames' chunk deltas into text plus tool calls, keyed by index.
//!
//! Half-parsed tool calls die here, satisfying the [`crate::llm::LlmClient`]
//! contract. A turn is only [`TurnAccumulator::finish`]ed into `Ok(ModelTurn)`
//! when a terminal `finish_reason` of `stop`/`tool_calls` was seen; a stream that
//! ends without one (a dropped connection mid-arguments) resolves to `Err`, so a
//! torn arguments buffer never escapes as a runnable call.

use std::collections::HashMap;

use serde::Deserialize;

use crate::llm::{LlmError, ModelTurn};
use crate::session::event::ToolCall;

/// One dispatched SSE event: a `data:` payload, or the `[DONE]` sentinel.
#[derive(Debug, Clone, PartialEq)]
pub enum SseFrame {
    Data(String),
    Done,
}

/// A push parser for the `text/event-stream` framing.
///
/// Splits on line boundaries (`\n`, tolerating `\r\n`), joins multi-line `data:`
/// fields with `\n`, ignores `:` comment/keepalive lines and non-`data` fields,
/// and dispatches one frame per blank-line-terminated event.
#[derive(Default)]
pub struct SseDecoder {
    /// Bytes not yet forming a complete line. Splitting on the `\n` byte is
    /// UTF-8 safe (a newline never appears inside a multi-byte sequence), so a
    /// partial line held here may hold an incomplete char without harm.
    buf: Vec<u8>,
    /// `data:` field values accumulated for the event currently being parsed.
    data: Vec<String>,
}

impl SseDecoder {
    pub fn new() -> Self {
        SseDecoder::default()
    }

    /// Feed a chunk of bytes, appending any newly completed frames to `out`.
    pub fn push(&mut self, chunk: &[u8], out: &mut Vec<SseFrame>) {
        self.buf.extend_from_slice(chunk);
        while let Some(newline) = self.buf.iter().position(|&byte| byte == b'\n') {
            let mut line: Vec<u8> = self.buf.drain(..=newline).collect();
            line.pop(); // drop '\n'
            if line.last() == Some(&b'\r') {
                line.pop(); // drop '\r' of a CRLF terminator
            }
            self.line(&line, out);
        }
    }

    /// Flush a final event that arrived without a terminating blank line (some
    /// servers send the last chunk then close the connection).
    pub fn finish(&mut self, out: &mut Vec<SseFrame>) {
        self.dispatch(out);
    }

    fn line(&mut self, line: &[u8], out: &mut Vec<SseFrame>) {
        if line.is_empty() {
            self.dispatch(out);
            return;
        }
        if line[0] == b':' {
            return; // comment / keepalive
        }
        let (field, value) = match line.iter().position(|&byte| byte == b':') {
            Some(colon) => {
                let value = &line[colon + 1..];
                // A single leading space after the colon is part of the framing.
                let value = value.strip_prefix(b" ").unwrap_or(value);
                (&line[..colon], value)
            }
            None => (line, &b""[..]),
        };
        if field == b"data" {
            self.data.push(String::from_utf8_lossy(value).into_owned());
        }
        // event:/id:/retry: carry no meaning for chat completions; ignore them.
    }

    fn dispatch(&mut self, out: &mut Vec<SseFrame>) {
        if self.data.is_empty() {
            return; // a blank line with no pending data is just a separator
        }
        let payload = std::mem::take(&mut self.data).join("\n");
        if payload == "[DONE]" {
            out.push(SseFrame::Done);
        } else {
            out.push(SseFrame::Data(payload));
        }
    }
}

// --- Chunk wire shape (a subset; unknown fields are ignored) ---------------

#[derive(Deserialize)]
struct Chunk {
    #[serde(default)]
    choices: Vec<Choice>,
    #[serde(default)]
    error: Option<ApiError>,
}

#[derive(Deserialize)]
struct Choice {
    #[serde(default)]
    delta: Delta,
    #[serde(default)]
    finish_reason: Option<String>,
}

#[derive(Deserialize, Default)]
struct Delta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Vec<ToolCallDelta>,
}

#[derive(Deserialize)]
struct ToolCallDelta {
    #[serde(default)]
    index: usize,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<FunctionDelta>,
}

#[derive(Deserialize)]
struct FunctionDelta {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

#[derive(Deserialize)]
struct ApiError {
    message: String,
}

/// One tool call being assembled across deltas.
struct PartialCall {
    id: Option<String>,
    name: String,
    arguments: String,
}

/// Folds SSE frames into a single [`ModelTurn`].
#[derive(Default)]
pub struct TurnAccumulator {
    text: String,
    /// Calls keyed by their streamed `index`, plus the order indices first
    /// appeared so the finished list is deterministic.
    calls: HashMap<usize, PartialCall>,
    order: Vec<usize>,
    finish_reason: Option<String>,
    /// An error object seen mid-stream; wins over any accumulated content.
    error: Option<String>,
}

impl TurnAccumulator {
    pub fn new() -> Self {
        TurnAccumulator::default()
    }

    /// Fold one frame in. A malformed `data:` payload is recorded as an error so
    /// [`finish`](Self::finish) fails loudly rather than dropping content silently.
    pub fn ingest(&mut self, frame: SseFrame) {
        let payload = match frame {
            SseFrame::Done => return, // stream terminator; finish_reason is the real signal
            SseFrame::Data(payload) => payload,
        };
        let chunk: Chunk = match serde_json::from_str(&payload) {
            Ok(chunk) => chunk,
            Err(err) => {
                self.error
                    .get_or_insert_with(|| format!("malformed stream chunk: {err}"));
                return;
            }
        };
        if let Some(api_error) = chunk.error {
            self.error.get_or_insert(api_error.message);
            return;
        }
        for choice in chunk.choices {
            if let Some(content) = choice.delta.content {
                self.text.push_str(&content);
            }
            for delta in choice.delta.tool_calls {
                self.merge_call(delta);
            }
            if let Some(reason) = choice.finish_reason {
                self.finish_reason = Some(reason);
            }
        }
    }

    fn merge_call(&mut self, delta: ToolCallDelta) {
        use std::collections::hash_map::Entry;
        let index = delta.index;
        // Record first-seen order the moment we mint a new call, so the finished
        // list is deterministic without capturing `self.order` in an entry closure.
        if let Entry::Vacant(slot) = self.calls.entry(index) {
            slot.insert(PartialCall {
                id: None,
                name: String::new(),
                arguments: String::new(),
            });
            self.order.push(index);
        }
        let call = self.calls.get_mut(&index).expect("just inserted");
        if let Some(id) = delta.id {
            if !id.is_empty() {
                call.id = Some(id);
            }
        }
        if let Some(function) = delta.function {
            if let Some(name) = function.name {
                call.name.push_str(&name);
            }
            if let Some(arguments) = function.arguments {
                call.arguments.push_str(&arguments);
            }
        }
    }

    /// Resolve the accumulated stream into a turn, or an error.
    ///
    /// Only `stop`/`tool_calls` yield `Ok`. A mid-stream error object, a stream
    /// that ended without a terminal `finish_reason`, or any other reason
    /// (`length`, `content_filter`, or the legacy `function_call`) yields `Err` —
    /// a truncated turn must not be handed back as if complete. `function_call`
    /// specifically is refused rather than accepted: this client parses only the
    /// modern `delta.tool_calls`, not the deprecated `delta.function_call`, so a
    /// `function_call` stop would otherwise silently drop the call the model made.
    pub fn finish(self) -> Result<ModelTurn, LlmError> {
        if let Some(message) = self.error {
            return Err(LlmError::new(message));
        }
        match self.finish_reason.as_deref() {
            Some("stop") | Some("tool_calls") => {
                let TurnAccumulator {
                    text,
                    mut calls,
                    order,
                    ..
                } = self;
                let tool_calls = order
                    .into_iter()
                    .filter_map(|index| calls.remove(&index).map(|call| (index, call)))
                    .map(|(index, call)| ToolCall {
                        // Missing id (some compatible providers omit it) → call_N.
                        call_id: call.id.unwrap_or_else(|| format!("call_{index}")),
                        name: call.name,
                        arguments: call.arguments,
                    })
                    .collect();
                Ok(ModelTurn { text, tool_calls })
            }
            Some(other) => Err(LlmError::new(format!(
                "model stopped early (finish_reason={other})"
            ))),
            None => Err(LlmError::new("stream ended before completion")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Drive a whole fixture through decoder + accumulator in one shot.
    fn accumulate(raw: &[u8]) -> Result<ModelTurn, LlmError> {
        let mut decoder = SseDecoder::new();
        let mut accumulator = TurnAccumulator::new();
        let mut frames = Vec::new();
        decoder.push(raw, &mut frames);
        decoder.finish(&mut frames);
        for frame in frames {
            accumulator.ingest(frame);
        }
        accumulator.finish()
    }

    /// Same, but fed `size` bytes at a time to prove incremental framing.
    fn accumulate_chunked(raw: &[u8], size: usize) -> Result<ModelTurn, LlmError> {
        let mut decoder = SseDecoder::new();
        let mut accumulator = TurnAccumulator::new();
        for piece in raw.chunks(size) {
            let mut frames = Vec::new();
            decoder.push(piece, &mut frames);
            for frame in frames {
                accumulator.ingest(frame);
            }
        }
        let mut frames = Vec::new();
        decoder.finish(&mut frames);
        for frame in frames {
            accumulator.ingest(frame);
        }
        accumulator.finish()
    }

    const PURE_TEXT: &str = concat!(
        "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"Hello\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\", world\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n",
    );

    const SINGLE_TOOL: &str = concat!(
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_abc\",\"type\":\"function\",\"function\":{\"name\":\"read\",\"arguments\":\"\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"path\\\":\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"a.txt\\\"}\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: [DONE]\n\n",
    );

    const MULTI_TOOL: &str = concat!(
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"read\",\"arguments\":\"{}\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":1,\"id\":\"call_2\",\"function\":{\"name\":\"list\",\"arguments\":\"{}\"}}]},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n",
        "data: [DONE]\n\n",
    );

    const MID_STREAM_ERROR: &str = concat!(
        "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"},\"finish_reason\":null}]}\n\n",
        "data: {\"error\":{\"message\":\"rate limit exceeded\",\"type\":\"rate_limit\"}}\n\n",
    );

    // Content, then a tool call cut off mid-arguments — no finish_reason, no [DONE].
    const BROKEN_STREAM: &str = concat!(
        "data: {\"choices\":[{\"delta\":{\"content\":\"thinking\"},\"finish_reason\":null}]}\n\n",
        "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_x\",\"function\":{\"name\":\"read\",\"arguments\":\"{\\\"pa\"}}]},\"finish_reason\":null}]}",
    );

    #[test]
    fn pure_text_turn() {
        let turn = accumulate(PURE_TEXT.as_bytes()).unwrap();
        assert_eq!(turn.text, "Hello, world");
        assert!(turn.tool_calls.is_empty());
    }

    #[test]
    fn single_tool_call_reassembles_arguments() {
        let turn = accumulate(SINGLE_TOOL.as_bytes()).unwrap();
        assert!(turn.text.is_empty());
        assert_eq!(turn.tool_calls.len(), 1);
        let call = &turn.tool_calls[0];
        assert_eq!(call.call_id, "call_abc");
        assert_eq!(call.name, "read");
        assert_eq!(call.arguments, r#"{"path":"a.txt"}"#);
    }

    #[test]
    fn multiple_tool_calls_kept_in_index_order() {
        let turn = accumulate(MULTI_TOOL.as_bytes()).unwrap();
        let names: Vec<&str> = turn.tool_calls.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["read", "list"]);
        let ids: Vec<&str> = turn.tool_calls.iter().map(|c| c.call_id.as_str()).collect();
        assert_eq!(ids, vec!["call_1", "call_2"]);
    }

    #[test]
    fn mid_stream_error_becomes_err() {
        let err = accumulate(MID_STREAM_ERROR.as_bytes()).unwrap_err();
        assert!(err.message.contains("rate limit"), "got: {}", err.message);
    }

    #[test]
    fn broken_stream_never_yields_a_half_call() {
        // No finish_reason arrived, so the torn `{"pa` arguments must not surface
        // as a runnable call — the turn fails instead.
        let err = accumulate(BROKEN_STREAM.as_bytes()).unwrap_err();
        assert!(err.message.contains("stream ended"), "got: {}", err.message);
    }

    #[test]
    fn chunked_delivery_matches_whole_buffer() {
        // Byte-at-a-time framing must reassemble identically to one buffer.
        let one_shot = accumulate(SINGLE_TOOL.as_bytes()).unwrap();
        let byte_by_byte = accumulate_chunked(SINGLE_TOOL.as_bytes(), 1).unwrap();
        assert_eq!(one_shot, byte_by_byte);
    }

    #[test]
    fn crlf_terminators_and_keepalive_comments_are_tolerated() {
        let with_crlf = PURE_TEXT.replace('\n', "\r\n");
        let with_keepalive = format!(": ping\r\n\r\n{with_crlf}");
        let turn = accumulate(with_keepalive.as_bytes()).unwrap();
        assert_eq!(turn.text, "Hello, world");
    }

    #[test]
    fn multiline_data_field_is_joined() {
        // One JSON object split across two data: lines (joined with '\n', which is
        // insignificant whitespace to a JSON parser). Missing id → call_0.
        let raw = concat!(
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\n",
            "data: \"function\":{\"name\":\"read\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n",
            "data: [DONE]\n\n",
        );
        let turn = accumulate(raw.as_bytes()).unwrap();
        assert_eq!(turn.tool_calls.len(), 1);
        assert_eq!(turn.tool_calls[0].call_id, "call_0");
        assert_eq!(turn.tool_calls[0].name, "read");
    }

    #[test]
    fn usage_only_chunk_and_empty_choices_are_ignored() {
        let raw = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"},\"finish_reason\":null}]}\n\n",
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":1}}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
            "data: [DONE]\n\n",
        );
        let turn = accumulate(raw.as_bytes()).unwrap();
        assert_eq!(turn.text, "hi");
    }

    #[test]
    fn finish_without_done_sentinel_still_completes() {
        // finish_reason, but the connection closes before a data: [DONE].
        let raw = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":null}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        );
        let turn = accumulate(raw.as_bytes()).unwrap();
        assert_eq!(turn.text, "ok");
    }

    #[test]
    fn legacy_function_call_finish_is_an_error() {
        // finish_reason "function_call" with the deprecated delta.function_call
        // field (which this client does not parse). Accepting it would return an
        // empty turn and silently drop the call; it must error instead.
        let raw = concat!(
            "data: {\"choices\":[{\"delta\":{\"function_call\":{\"name\":\"read\",\"arguments\":\"{}\"}},\"finish_reason\":null}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"function_call\"}]}\n\n",
            "data: [DONE]\n\n",
        );
        let err = accumulate(raw.as_bytes()).unwrap_err();
        assert!(
            err.message.contains("function_call"),
            "got: {}",
            err.message
        );
    }

    #[test]
    fn length_finish_reason_is_an_error() {
        let raw = concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"cut\"},\"finish_reason\":null}]}\n\n",
            "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\n",
            "data: [DONE]\n\n",
        );
        let err = accumulate(raw.as_bytes()).unwrap_err();
        assert!(err.message.contains("length"), "got: {}", err.message);
    }
}
