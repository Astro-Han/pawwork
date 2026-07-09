//! pawwork-rs: CLI adapter for the Rust agent core.
//!
//! M0 placeholder. The interactive loop (chat, confirm, resume, Ctrl-C) lands
//! in a later PR; for now this proves the workspace wires the core lib.

use pawwork_core::session::paths::ledger_root;

fn main() {
    println!(
        "pawwork-rs {} (ledger root: {})",
        env!("CARGO_PKG_VERSION"),
        ledger_root().display(),
    );
}
