//! The `shell` tool: run one command in the workspace under confirmation.
//!
//! Unlike the file tools, `shell` is **not** path-fenced. A shell command's reach
//! is unbounded by nature (it can invoke any program, touch any path), so a path
//! fence would be security theatre. Its real boundary is the permission gate:
//! `requires_confirmation` is always `true` — the default, most-cautious tier —
//! and the user approves the exact command line before it runs.
//!
//! Runtime discipline:
//! - Each call spawns `/bin/sh -c <command>` with `current_dir` set to the
//!   workspace root, stdin closed (`Stdio::null`, so a command that reads stdin —
//!   `cat` — sees EOF and terminates instead of hanging the turn), and stdout /
//!   stderr piped.
//! - stdout and stderr are drained concurrently, each capped at
//!   [`MAX_SHELL_CAPTURE`]. The drain *keeps reading and discarding* past the cap,
//!   so a chatty child never blocks on a full pipe (which would deadlock against
//!   our own `wait`). After the child exits, the drain gets [`DRAIN_GRACE`] to
//!   reach EOF: a command that backgrounds a survivor (`server &`) leaves the
//!   pipe open indefinitely, and the turn must not be pinned on that orphan —
//!   the capture so far is returned, marked truncated, and the orphan keeps
//!   running (killing it would defeat deliberately backgrounded work).
//! - A [`ShellTool::timeout`] and the turn's [`CancellationToken`] both race the
//!   process; either one kills the whole process tree and returns `Err`. Tree kill
//!   is best-effort: on unix we `SIGKILL` the negative process-group id (the child
//!   leads its own group via `process_group(0)`), then also call `child.kill()` as
//!   a fallback; on other platforms only `child.kill()` is available.

use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};
use tokio_util::sync::CancellationToken;

use super::{BoxFuture, PreparedCall, Tool, ToolContext, ToolResult, MISMATCHED_CALL};

/// Default wall-clock budget for one command. Long enough for a real build or test
/// run, bounded so a hung command cannot pin the turn forever. Overridable per
/// tool so tests can use a tiny value.
pub const DEFAULT_SHELL_TIMEOUT: Duration = Duration::from_secs(120);

/// Per-stream capture cap. Enough context for the model to act on, bounded so a
/// flood of output cannot blow memory or the model's context window.
const MAX_SHELL_CAPTURE: usize = 32 * 1024;

/// How long after the child exits the drain may keep waiting for pipe EOF.
/// Normally EOF is immediate; the grace only elapses when a backgrounded
/// survivor still holds the write end, in which case the drain is abandoned
/// with whatever was captured.
const DRAIN_GRACE: Duration = Duration::from_secs(2);

/// `shell`: run one command via `/bin/sh -c` in the workspace.
pub struct ShellTool {
    timeout: Duration,
}

impl ShellTool {
    /// Construct with an explicit timeout. Built-ins pass
    /// [`DEFAULT_SHELL_TIMEOUT`]; tests pass a tiny value to exercise the
    /// timeout path quickly.
    pub fn new(timeout: Duration) -> Self {
        ShellTool { timeout }
    }
}

impl Tool for ShellTool {
    fn name(&self) -> &str {
        "shell"
    }

    fn description(&self) -> &str {
        "Run one shell command via /bin/sh -c in the workspace directory. stdin is \
         closed and stdout/stderr are captured (truncated if large) and returned. \
         Use it for terminal operations like git, build, and test commands, not for \
         reading, writing, or listing files (use read/write/edit). A non-zero exit \
         is returned as an error including the captured output; the command runs to \
         a timeout and requires confirmation."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The command line to run, as a single /bin/sh -c string."
                }
            },
            "required": ["command"],
            "additionalProperties": false
        })
    }

    fn requires_confirmation(&self) -> bool {
        true
    }

    fn prepare(&self, _ctx: &ToolContext, args: &Value) -> Result<PreparedCall, String> {
        let command = args
            .get("command")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| "missing required string argument 'command'".to_string())?;
        Ok(PreparedCall::Shell {
            command: command.to_string(),
        })
    }

    fn summarize(&self, prepared: &PreparedCall) -> String {
        match prepared {
            PreparedCall::Shell { command } => format!("run `{command}`"),
            _ => "run shell".to_string(),
        }
    }

    fn run<'a>(
        &'a self,
        ctx: &'a ToolContext,
        prepared: &'a PreparedCall,
    ) -> BoxFuture<'a, ToolResult> {
        let PreparedCall::Shell { command } = prepared else {
            return Box::pin(async { Err(MISMATCHED_CALL.to_string()) });
        };
        let command = command.clone();
        let workspace_root = ctx.workspace_root.clone();
        let cancel = ctx.cancel.clone();
        let timeout = self.timeout;
        Box::pin(async move { run_command(command, workspace_root, cancel, timeout).await })
    }
}

/// What a single output stream captured, and whether it was cut off (at the cap,
/// or by abandoning a drain whose pipe an orphan kept open).
struct Captured {
    bytes: Vec<u8>,
    truncated: bool,
}

/// A capture buffer shared between the drain task and the joiner, so an abandoned
/// drain still surrenders the bytes it captured before the grace elapsed.
type CaptureSlot = Arc<Mutex<Captured>>;

fn capture_slot() -> CaptureSlot {
    Arc::new(Mutex::new(Captured {
        bytes: Vec::new(),
        truncated: false,
    }))
}

/// Lock a slot, recovering from poisoning: a panicked drain task must not take
/// the whole tool result down with it.
fn lock_slot(slot: &CaptureSlot) -> std::sync::MutexGuard<'_, Captured> {
    slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

async fn run_command(
    command: String,
    workspace_root: std::path::PathBuf,
    cancel: CancellationToken,
    timeout: Duration,
) -> ToolResult {
    let mut builder = Command::new("/bin/sh");
    builder
        .arg("-c")
        .arg(&command)
        .current_dir(&workspace_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Put the child in its own process group so a timeout / cancel can kill the
    // whole tree, not just the leader.
    #[cfg(unix)]
    builder.process_group(0);

    let mut child = builder
        .spawn()
        .map_err(|err| format!("failed to start shell: {err}"))?;
    // Captured before any `wait`, which would drop the id.
    let pid = child.id();

    // Drain both pipes concurrently so a full pipe cannot block `wait`.
    let stdout = child.stdout.take().expect("stdout was piped");
    let stderr = child.stderr.take().expect("stderr was piped");
    let stdout_slot = capture_slot();
    let stderr_slot = capture_slot();
    let stdout_task = tokio::spawn(drain_capped(stdout, stdout_slot.clone()));
    let stderr_task = tokio::spawn(drain_capped(stderr, stderr_slot.clone()));

    let status = tokio::select! {
        waited = child.wait() => {
            waited.map_err(|err| format!("failed to wait for shell: {err}"))?
        }
        _ = cancel.cancelled() => {
            kill_tree(&mut child, pid).await;
            return Err("cancelled".to_string());
        }
        _ = tokio::time::sleep(timeout) => {
            kill_tree(&mut child, pid).await;
            return Err(format!("command timed out after {}s", timeout.as_secs()));
        }
    };

    let stdout = join_captured(stdout_task, stdout_slot).await;
    let stderr = join_captured(stderr_task, stderr_slot).await;
    let stdout_text = render(stdout);
    let stderr_text = render(stderr);

    if status.success() {
        // Exit 0: return stdout, appending a labelled stderr only if the command
        // wrote to it (warnings, progress).
        let mut out = stdout_text;
        if !stderr_text.is_empty() {
            out.push_str("\n[stderr]\n");
            out.push_str(&stderr_text);
        }
        Ok(out)
    } else {
        // Non-zero exit is a recoverable tool error: the model sees the code and
        // the output so it can react.
        let code = status
            .code()
            .map(|code| code.to_string())
            .unwrap_or_else(|| "terminated by signal".to_string());
        let mut out = format!("command exited with status {code}");
        if !stdout_text.is_empty() {
            out.push_str("\n[stdout]\n");
            out.push_str(&stdout_text);
        }
        if !stderr_text.is_empty() {
            out.push_str("\n[stderr]\n");
            out.push_str(&stderr_text);
        }
        Err(out)
    }
}

/// Read a stream to EOF into the shared slot, keeping at most
/// [`MAX_SHELL_CAPTURE`] bytes but always draining the rest (so the child never
/// blocks on a full pipe). Writes into the slot incrementally so an abandoned
/// drain still leaves its capture behind.
async fn drain_capped<R: AsyncRead + Unpin>(mut reader: R, slot: CaptureSlot) {
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf).await {
            Ok(0) => break,
            Ok(read) => {
                let mut captured = lock_slot(&slot);
                if captured.bytes.len() < MAX_SHELL_CAPTURE {
                    let room = MAX_SHELL_CAPTURE - captured.bytes.len();
                    let take = room.min(read);
                    captured.bytes.extend_from_slice(&buf[..take]);
                    if take < read {
                        captured.truncated = true;
                    }
                } else {
                    // Past the cap: discard, but keep reading to drain the pipe.
                    captured.truncated = true;
                }
            }
            Err(_) => break,
        }
    }
}

/// Await a drain task for at most [`DRAIN_GRACE`], then take the slot's capture.
/// The child has already exited here, so a drain that is still blocked can only
/// be waiting on an orphan that inherited the pipe — abandon it (marking the
/// capture truncated) rather than pin the turn on a process we chose not to kill.
async fn join_captured(mut task: tokio::task::JoinHandle<()>, slot: CaptureSlot) -> Captured {
    if tokio::time::timeout(DRAIN_GRACE, &mut task).await.is_err() {
        task.abort();
        lock_slot(&slot).truncated = true;
    }
    let captured = lock_slot(&slot);
    Captured {
        bytes: captured.bytes.clone(),
        truncated: captured.truncated,
    }
}

fn render(stream: Captured) -> String {
    let mut text = String::from_utf8_lossy(&stream.bytes).into_owned();
    if stream.truncated {
        text.push_str("\n… [truncated]");
    }
    text
}

/// Best-effort kill of the whole process tree. On unix, `SIGKILL` the negative
/// process-group id (set up via `process_group(0)`), then also `child.kill()` as a
/// fallback; elsewhere only `child.kill()` is available.
async fn kill_tree(child: &mut Child, pid: Option<u32>) {
    #[cfg(unix)]
    if let Some(pid) = pid {
        // Safety: `kill(2)` with a negative pid signals the process group. A stale
        // pid at worst signals nothing; it cannot corrupt our address space.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    let _ = pid;
    let _ = child.kill().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn ctx() -> ToolContext {
        ToolContext {
            workspace_root: std::env::temp_dir(),
            cancel: CancellationToken::new(),
        }
    }

    fn prepared(command: &str) -> PreparedCall {
        PreparedCall::Shell {
            command: command.to_string(),
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn echo_returns_stdout() {
        let tool = ShellTool::new(DEFAULT_SHELL_TIMEOUT);
        let out = tool.run(&ctx(), &prepared("echo hello")).await.unwrap();
        assert_eq!(out.trim(), "hello");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn stderr_is_captured_and_labelled() {
        let tool = ShellTool::new(DEFAULT_SHELL_TIMEOUT);
        let out = tool
            .run(&ctx(), &prepared("echo out; echo err 1>&2"))
            .await
            .unwrap();
        assert!(out.contains("out"), "stdout present, got: {out}");
        assert!(out.contains("[stderr]"), "stderr labelled, got: {out}");
        assert!(out.contains("err"), "stderr captured, got: {out}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn non_zero_exit_is_error_with_code() {
        let tool = ShellTool::new(DEFAULT_SHELL_TIMEOUT);
        let err = tool
            .run(&ctx(), &prepared("exit 3"))
            .await
            .expect_err("non-zero exit must be an error");
        assert!(err.contains('3'), "exit code named, got: {err}");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn command_reading_stdin_terminates() {
        // stdin is closed, so `cat` sees EOF and exits instead of hanging.
        let tool = ShellTool::new(Duration::from_secs(5));
        let out = tool.run(&ctx(), &prepared("cat")).await.unwrap();
        assert_eq!(out, "", "cat on empty stdin yields no output");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn large_output_is_truncated_but_command_completes() {
        // ~100 KiB of output, well past the 32 KiB cap: the drain keeps reading so
        // the command can finish, and the result is marked truncated.
        let tool = ShellTool::new(Duration::from_secs(10));
        let out = tool
            .run(&ctx(), &prepared("yes | head -c 100000"))
            .await
            .unwrap();
        assert!(out.ends_with("[truncated]"), "must be truncated");
        assert!(
            out.len() < 100000,
            "captured output must be capped, got {} bytes",
            out.len()
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn background_survivor_does_not_pin_the_turn() {
        // The command exits immediately but backgrounds a `sleep` that inherits
        // the stdout pipe, so the pipe never reaches EOF. The drain must be
        // abandoned after the grace period, keeping the output that did arrive.
        let tool = ShellTool::new(Duration::from_secs(30));
        let started = Instant::now();
        let out = tool
            .run(&ctx(), &prepared("echo hi; sleep 30 &"))
            .await
            .unwrap();
        assert!(out.contains("hi"), "pre-orphan output kept, got: {out}");
        assert!(
            out.contains("[truncated]"),
            "an abandoned drain must be marked, got: {out}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "the orphan must not pin the turn, took {:?}",
            started.elapsed()
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn timeout_kills_a_long_command_promptly() {
        let tool = ShellTool::new(Duration::from_millis(200));
        let started = Instant::now();
        let err = tool
            .run(&ctx(), &prepared("sleep 30"))
            .await
            .expect_err("a timed-out command must be an error");
        assert!(err.contains("timed out"), "got: {err}");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "timeout must fire promptly, took {:?}",
            started.elapsed()
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cancellation_returns_error_promptly() {
        let context = ctx();
        let cancel = context.cancel.clone();
        let tool = ShellTool::new(Duration::from_secs(30));
        let call = prepared("sleep 30");
        let started = Instant::now();
        let canceller = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            cancel.cancel();
        });
        let err = tool
            .run(&context, &call)
            .await
            .expect_err("a cancelled command must be an error");
        canceller.await.unwrap();
        assert!(err.contains("cancelled"), "got: {err}");
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "cancel must fire promptly, took {:?}",
            started.elapsed()
        );
    }
}
