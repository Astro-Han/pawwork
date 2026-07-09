//! Outbound request construction for the OpenAI-compatible chat/completions API.
//!
//! The only non-mechanical part here is pairing sanitation. A real provider
//! rejects a request (HTTP 400) when an assistant message carries a `tool_calls`
//! entry that never receives a matching `tool` result — the exact state the turn
//! loop leaves in its in-memory history when a batch is cancelled mid-permission
//! or mid-execution (see `docs/architecture/2026-07-09-rust-agent-v0.md`, §13,
//! P2-2). The fix lives *here*, at request construction: any unpaired `tool_call`
//! is answered with a synthesized "cancelled" tool result in the outbound body.
//! The ledger and the loop's history are never mutated — sanitation is a
//! projection onto the wire, not a rewrite of the record.

use serde_json::{json, Value};

use crate::llm::ChatMessage;

/// The fed-back result for a `tool_call` that was never executed, synthesized
/// only into the outbound request so the provider sees a paired call.
const CANCELLED_TOOL_RESULT: &str = "Tool call was cancelled before execution.";

/// Provider-shaped bits of a request that live on the client, not in the
/// per-turn history: the model id, the tool schemas the model may call, and an
/// optional system prompt. Deliberately holds pre-built tool JSON rather than the
/// [`crate::tool::ToolRuntime`] — turning tools into schemas is a wiring concern
/// for the CLI PR, and keeping it out here leaves the tool trait untouched.
#[derive(Debug, Clone)]
pub struct RequestConfig {
    pub model: String,
    pub tools: Vec<Value>,
    pub system_prompt: Option<String>,
}

/// Build the JSON body for a streaming chat/completions request from the running
/// history, sanitizing any unpaired `tool_call` (see the module note).
pub fn build_request_body(config: &RequestConfig, history: &[ChatMessage]) -> Value {
    let mut body = json!({
        "model": config.model,
        "messages": messages(config.system_prompt.as_deref(), history),
        "stream": true,
    });
    if !config.tools.is_empty() {
        body["tools"] = Value::Array(config.tools.clone());
    }
    body
}

/// Convert the history into OpenAI messages, appending a synthesized `tool`
/// result for every `tool_call` that has no real result following it.
fn messages(system_prompt: Option<&str>, history: &[ChatMessage]) -> Vec<Value> {
    let mut out = Vec::new();
    if let Some(prompt) = system_prompt {
        out.push(json!({ "role": "system", "content": prompt }));
    }
    for (position, message) in history.iter().enumerate() {
        match message {
            ChatMessage::User(text) => {
                out.push(json!({ "role": "user", "content": text }));
            }
            ChatMessage::Assistant { text, tool_calls } if tool_calls.is_empty() => {
                out.push(json!({ "role": "assistant", "content": text }));
            }
            ChatMessage::Assistant { text, tool_calls } => {
                let calls: Vec<Value> = tool_calls
                    .iter()
                    .map(|call| {
                        json!({
                            "id": call.call_id,
                            "type": "function",
                            "function": { "name": call.name, "arguments": call.arguments },
                        })
                    })
                    .collect();
                // Content is null (not "") when the assistant only made tool calls,
                // matching the shape providers emit and expect back.
                let content = if text.is_empty() {
                    Value::Null
                } else {
                    json!(text)
                };
                out.push(json!({
                    "role": "assistant",
                    "content": content,
                    "tool_calls": calls,
                }));
                // Sanitize: answer every unpaired call so the batch is complete on
                // the wire even though the loop never ran (or finished) it. Pair
                // positionally — a call is answered only by a Tool result in the
                // run of Tool messages that immediately follows this assistant (how
                // the loop records them). A whole-history id set would be wrong
                // when ids collide across rounds: a provider that omits ids makes
                // every first call fall back to `call_0`, so an executed `call_0`
                // in an earlier round must not mask a cancelled `call_0` here.
                let answered: std::collections::HashSet<&str> = history[position + 1..]
                    .iter()
                    .map_while(|following| match following {
                        ChatMessage::Tool { call_id, .. } => Some(call_id.as_str()),
                        _ => None,
                    })
                    .collect();
                for call in tool_calls {
                    if !answered.contains(call.call_id.as_str()) {
                        out.push(json!({
                            "role": "tool",
                            "tool_call_id": call.call_id,
                            "content": CANCELLED_TOOL_RESULT,
                        }));
                    }
                }
            }
            ChatMessage::Tool { call_id, content } => {
                out.push(json!({
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": content,
                }));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::event::ToolCall;

    fn config() -> RequestConfig {
        RequestConfig {
            model: "test-model".to_string(),
            tools: Vec::new(),
            system_prompt: None,
        }
    }

    fn tool_call(call_id: &str, name: &str, arguments: &str) -> ToolCall {
        ToolCall {
            call_id: call_id.to_string(),
            name: name.to_string(),
            arguments: arguments.to_string(),
        }
    }

    /// Every assistant `tool_call` id that has no matching `tool` message is a
    /// dangling call — the exact thing a provider rejects with a 400.
    fn dangling_call_ids(body: &Value) -> Vec<String> {
        let messages = body["messages"].as_array().unwrap();
        let answered: std::collections::HashSet<&str> = messages
            .iter()
            .filter(|m| m["role"] == json!("tool"))
            .filter_map(|m| m["tool_call_id"].as_str())
            .collect();
        messages
            .iter()
            .filter(|m| m["role"] == json!("assistant"))
            .filter_map(|m| m["tool_calls"].as_array())
            .flatten()
            .filter_map(|call| call["id"].as_str())
            .filter(|id| !answered.contains(id))
            .map(str::to_string)
            .collect()
    }

    #[test]
    fn plain_conversation_roundtrips_roles() {
        let history = vec![
            ChatMessage::User("hi".to_string()),
            ChatMessage::Assistant {
                text: "hello".to_string(),
                tool_calls: Vec::new(),
            },
        ];
        let body = build_request_body(&config(), &history);
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0], json!({ "role": "user", "content": "hi" }));
        assert_eq!(
            messages[1],
            json!({ "role": "assistant", "content": "hello" })
        );
        assert_eq!(body["stream"], json!(true));
        assert_eq!(body["model"], json!("test-model"));
        assert!(body.get("tools").is_none(), "no tools => omit the field");
    }

    #[test]
    fn paired_tool_call_is_left_untouched() {
        let history = vec![
            ChatMessage::Assistant {
                text: String::new(),
                tool_calls: vec![tool_call("c1", "read", r#"{"path":"a.txt"}"#)],
            },
            ChatMessage::Tool {
                call_id: "c1".to_string(),
                content: "file body".to_string(),
            },
        ];
        let body = build_request_body(&config(), &history);
        assert!(dangling_call_ids(&body).is_empty());
        let tool_messages: Vec<_> = body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["role"] == json!("tool"))
            .collect();
        assert_eq!(tool_messages.len(), 1, "no synthesized duplicate result");
        assert_eq!(tool_messages[0]["content"], json!("file body"));
    }

    #[test]
    fn unpaired_tool_call_gets_synthesized_result() {
        // Assistant asked for a call; the loop was cancelled before answering it.
        let history = vec![ChatMessage::Assistant {
            text: String::new(),
            tool_calls: vec![tool_call("c1", "danger", "{}")],
        }];
        let body = build_request_body(&config(), &history);
        assert!(
            dangling_call_ids(&body).is_empty(),
            "the unpaired call must be answered on the wire"
        );
        let tool_message = body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["role"] == json!("tool"))
            .expect("a synthesized tool result");
        assert_eq!(tool_message["tool_call_id"], json!("c1"));
        assert_eq!(tool_message["content"], json!(CANCELLED_TOOL_RESULT));
    }

    #[test]
    fn partially_answered_batch_only_synthesizes_the_gap() {
        // Two calls, only the first executed before cancellation.
        let history = vec![
            ChatMessage::Assistant {
                text: String::new(),
                tool_calls: vec![tool_call("c1", "read", "{}"), tool_call("c2", "read", "{}")],
            },
            ChatMessage::Tool {
                call_id: "c1".to_string(),
                content: "done".to_string(),
            },
        ];
        let body = build_request_body(&config(), &history);
        assert!(dangling_call_ids(&body).is_empty());
        let answered: Vec<&str> = body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["role"] == json!("tool"))
            .map(|m| m["tool_call_id"].as_str().unwrap())
            .collect();
        assert!(answered.contains(&"c1") && answered.contains(&"c2"));
    }

    #[test]
    fn colliding_fallback_ids_across_rounds_are_paired_positionally() {
        // A provider that omits tool_call ids makes every first call fall back to
        // "call_0". Round 1 executed; round 2 cancelled. A whole-history id set
        // would see round 1's result and wrongly treat round 2's call_0 as
        // answered, leaking a dangling call; positional pairing must not.
        let history = vec![
            ChatMessage::Assistant {
                text: String::new(),
                tool_calls: vec![tool_call("call_0", "read", "{}")],
            },
            ChatMessage::Tool {
                call_id: "call_0".to_string(),
                content: "round 1 result".to_string(),
            },
            ChatMessage::Assistant {
                text: String::new(),
                tool_calls: vec![tool_call("call_0", "read", "{}")],
            },
            // No tool result for round 2: cancelled before execution.
        ];
        let body = build_request_body(&config(), &history);
        let tool_messages: Vec<&Value> = body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["role"] == json!("tool"))
            .collect();
        // Two results: round 1's real one and round 2's synthesized cancellation.
        assert_eq!(tool_messages.len(), 2);
        assert!(tool_messages
            .iter()
            .any(|m| m["content"] == json!("round 1 result")));
        assert!(tool_messages
            .iter()
            .any(|m| m["content"] == json!(CANCELLED_TOOL_RESULT)));
    }

    #[test]
    fn assistant_with_tool_calls_has_null_content() {
        let history = vec![ChatMessage::Assistant {
            text: String::new(),
            tool_calls: vec![tool_call("c1", "read", "{}")],
        }];
        let body = build_request_body(&config(), &history);
        let assistant = &body["messages"].as_array().unwrap()[0];
        assert_eq!(assistant["content"], Value::Null);
    }

    #[test]
    fn system_prompt_and_tools_are_emitted_when_set() {
        let config = RequestConfig {
            model: "m".to_string(),
            tools: vec![json!({ "type": "function", "function": { "name": "read" } })],
            system_prompt: Some("be terse".to_string()),
        };
        let body = build_request_body(&config, &[ChatMessage::User("hi".to_string())]);
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(
            messages[0],
            json!({ "role": "system", "content": "be terse" })
        );
        assert_eq!(body["tools"].as_array().unwrap().len(), 1);
    }
}
