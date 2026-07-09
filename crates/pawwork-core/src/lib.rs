//! pawwork-core: UI-less agent core (ledger, tools, llm) for the Rust line.
//!
//! Layers (see `docs/architecture/2026-07-09-rust-agent-v0.md`, section 13):
//! - [`session`] — JSONL ledger, the single source of truth (PR1).
//! - [`llm`] — the [`llm::LlmClient`] boundary plus a scripted mock.
//! - [`tool`] — the [`tool::Tool`] boundary, a runtime registry, and the
//!   read-only `read`/`list` tools with their workspace path fence.
//! - [`permission`] — the [`permission::PermissionGate`] callback boundary.
//! - [`agent`] — the turn loop that wires them together, appends ledger events,
//!   and mirrors them onto a wire event stream.
//!
//! The core never touches stdin or builds a runtime; adapters (CLI, later Tauri)
//! own the runtime flavor and the interactive surface.

pub mod agent;
pub mod llm;
pub mod permission;
pub mod session;
pub mod tool;
