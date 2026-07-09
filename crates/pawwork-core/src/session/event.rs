//! Ledger event types.
//!
//! Each JSONL line is a [`LedgerEvent`]: an envelope (`schema`, `event_id`,
//! `seq`, `turn_id`) plus a `type`-tagged [`EventKind`] payload. Token-level
//! `model.delta` is a wire concern and intentionally has no ledger variant.

use serde::{Deserialize, Serialize};

/// Ledger schema version. Bump on any incompatible change to the on-disk shape.
pub const SCHEMA: u32 = 1;

/// One appended ledger record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LedgerEvent {
    pub schema: u32,
    pub event_id: String,
    pub seq: u64,
    pub turn_id: Option<String>,
    #[serde(flatten)]
    pub kind: EventKind,
}

/// A single tool call carried on a `model.message`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub call_id: String,
    pub name: String,
    pub arguments: String,
}

/// The `type`-tagged payload of a ledger event.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EventKind {
    SessionCreated {
        workspace: String,
    },
    UserMessage {
        text: String,
    },
    ModelMessage {
        text: String,
        tool_calls: Vec<ToolCall>,
    },
    ToolStarted {
        call_id: String,
        name: String,
    },
    ToolFinished {
        call_id: String,
        ok: bool,
        output: String,
    },
    PermissionRequested {
        call_id: String,
        action: String,
    },
    PermissionDecided {
        call_id: String,
        allowed: bool,
    },
    TurnCompleted,
    TurnInterrupted {
        reason: String,
    },
    Error {
        message: String,
    },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_and_tag_roundtrip() {
        let event = LedgerEvent {
            schema: SCHEMA,
            event_id: "e1".to_string(),
            seq: 7,
            turn_id: Some("t1".to_string()),
            kind: EventKind::ToolStarted {
                call_id: "c1".to_string(),
                name: "read".to_string(),
            },
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.contains(r#""type":"tool_started""#));
        assert!(json.contains(r#""seq":7"#));
        let back: LedgerEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(event, back);
    }
}
