//! The `shell` tool: run one command in the workspace under confirmation.
//!
//! Unlike the file tools, `shell` is **not** path-fenced. A shell command's reach
//! is unbounded by nature (it can invoke any program, touch any path), so a path
//! fence would be security theatre. Its real boundary is the permission gate:
//! `requires_confirmation` is always `true` — the default, most-cautious tier —
//! and the user approves the exact command line before it runs.
//!
//! Runtime discipline:
//! - Each call spawns the platform shell — `/bin/sh -c <command>` on unix, `cmd /C
//!   <command>` on windows — with `current_dir` set to the workspace root, stdin
//!   closed (`Stdio::null`, so a command that reads stdin sees EOF and terminates
//!   instead of hanging the turn), and stdout / stderr piped.
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
//!   leads its own group via `process_group(0)`), on windows we `taskkill /T /F`
//!   the pid tree, and both then also call `child.kill()` as a fallback; on other
//!   platforms only `child.kill()` is available.

use std::collections::VecDeque;
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

/// When output exceeds [`MAX_SHELL_CAPTURE`], keep this much of the head and the rest
/// as a rolling tail, so both the command's opening context *and* its final, usually
/// most actionable output (a test runner's last failure) survive — instead of keeping
/// only the head and discarding the ending. `CAPTURE_HEAD + CAPTURE_TAIL` equals the
/// cap, so the retained bytes never exceed it.
const CAPTURE_HEAD: usize = 24 * 1024;
const CAPTURE_TAIL: usize = MAX_SHELL_CAPTURE - CAPTURE_HEAD;

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
        // Name the actual platform shell so the model writes syntax that runs: POSIX
        // for `/bin/sh` on unix, cmd.exe syntax on windows (`dir`, no single quotes,
        // `nul` not `/dev/null`).
        #[cfg(not(windows))]
        {
            "Run one shell command via /bin/sh -c in the workspace directory, using \
             POSIX shell syntax. stdin is closed and stdout/stderr are captured \
             (truncated if large) and returned. Use it for terminal operations like \
             git, build, and test commands, not for reading, writing, or listing \
             files (use read/write/edit). A non-zero exit is returned as an error \
             including the captured output; the command runs to a timeout and \
             requires confirmation."
        }
        #[cfg(windows)]
        {
            "Run one shell command via cmd.exe (cmd /C) in the workspace directory, \
             using Windows cmd syntax (not POSIX). stdin is closed and stdout/stderr \
             are captured (truncated if large) and returned. Use it for terminal \
             operations like git, build, and test commands, not for reading, writing, \
             or listing files (use read/write/edit). A non-zero exit is returned as \
             an error including the captured output; the command runs to a timeout \
             and requires confirmation."
        }
    }

    fn parameters(&self) -> Value {
        #[cfg(not(windows))]
        let command_desc = "The command line to run, as a single /bin/sh -c string.";
        #[cfg(windows)]
        let command_desc = "The command line to run, as a single cmd /C string.";
        json!({
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": command_desc
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

/// What a single output stream captured. When output exceeds the cap the `head` holds
/// the first [`CAPTURE_HEAD`] bytes and `tail` the last [`CAPTURE_TAIL`], with
/// `dropped` counting the bytes discarded between them. `abandoned` marks a drain cut
/// off because an orphan kept the pipe open past the grace.
struct Captured {
    head: Vec<u8>,
    tail: VecDeque<u8>,
    dropped: usize,
    abandoned: bool,
}

/// A capture buffer shared between the drain task and the joiner, so an abandoned
/// drain still surrenders the bytes it captured before the grace elapsed.
type CaptureSlot = Arc<Mutex<Captured>>;

fn capture_slot() -> CaptureSlot {
    Arc::new(Mutex::new(Captured {
        head: Vec::new(),
        tail: VecDeque::new(),
        dropped: 0,
        abandoned: false,
    }))
}

/// Lock a slot, recovering from poisoning: a panicked drain task must not take
/// the whole tool result down with it.
fn lock_slot(slot: &CaptureSlot) -> std::sync::MutexGuard<'_, Captured> {
    slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Whether `path` is a UNC path (`\\server\share\...` or its verbatim form).
/// `cmd.exe` cannot use a UNC path as its working directory.
#[cfg(windows)]
fn is_unc_path(path: &std::path::Path) -> bool {
    use std::path::{Component, Prefix};
    matches!(
        path.components().next(),
        Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::UNC(..) | Prefix::VerbatimUNC(..))
    )
}

async fn run_command(
    command: String,
    workspace_root: std::path::PathBuf,
    cancel: CancellationToken,
    timeout: Duration,
) -> ToolResult {
    // `cmd.exe` cannot use a UNC path as its current directory: handed one it prints
    // a warning and silently falls back to the Windows directory, so a `current_dir`
    // set to a UNC workspace is ignored and an approved relative-path command would
    // execute *outside* the workspace, defeating the fence. Refuse to spawn rather
    // than run in the wrong place.
    #[cfg(windows)]
    if is_unc_path(&workspace_root) {
        // Path-free on purpose: this error is fed back to the model as a tool result
        // and sent to the provider next turn, so echoing the canonical UNC root would
        // leak the server/share layout (same reason edit/write return relative paths).
        return Err(
            "cannot run shell command: the workspace root is a UNC path, which cmd.exe \
             cannot use as a working directory"
                .to_string(),
        );
    }
    // Pick the platform shell: unix runs `/bin/sh -c <command>`, windows runs
    // `cmd /D /S /C "<command>"` (verbatim, see the windows branch below).
    #[cfg(unix)]
    let mut builder = {
        let mut builder = Command::new("/bin/sh");
        builder.arg("-c").arg(&command);
        builder
    };
    #[cfg(windows)]
    let mut builder = {
        // `raw_arg` is inherent on tokio's `Command` (no std `CommandExt` import
        // needed): append the command line verbatim, bypassing the default escaping.
        let mut builder = Command::new("cmd");
        // Hand the command line to cmd verbatim. Rust's normal `.arg()` escaping
        // targets CommandLineToArgvW, but `cmd /C` parses by different rules, so
        // `.arg(&command)` would rewrite embedded quotes/metacharacters into a
        // *different* command than the approved `PreparedCall` (e.g. a
        // `git commit -m "msg"`). `raw_arg` appends without escaping; `/S` makes cmd
        // strip exactly the outer quotes and run the remainder literally, so the
        // approved command line — and nothing else — is what actually executes. `/D`
        // disables execution of the `Command Processor\AutoRun` registry value, which
        // `cmd` would otherwise run *before* the approved command — a side effect
        // absent from the `PreparedCall` the user approved, defeating the exact-command
        // guarantee.
        //
        // No encoding-normalization prefix (e.g. `chcp 65001`) is injected here: it
        // would run a command the permission gate never approved *and* persistently
        // mutate the shared console's code page. Output is instead decoded lossily as
        // UTF-8 (see `render`); the residual mojibake for non-ASCII output under a
        // legacy console code page is a documented limitation.
        builder.raw_arg(format!("/D /S /C \"{command}\""));
        builder
    };
    builder
        .current_dir(&workspace_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // On unix, put the child in its own process group so a timeout / cancel can kill
    // the whole tree, not just the leader. Windows has no process groups; tree kill
    // there goes through `taskkill /T` by pid (see `kill_tree`), so nothing to set.
    #[cfg(unix)]
    builder.process_group(0);
    // On windows, cmd (and CreateProcess) search the *current directory* for an
    // executable before `PATH` by default. Since the current directory is the
    // workspace, a repo that plants `git.exe`/`git.cmd` there would run on an approved
    // `git status` — repository-controlled code from a benign-looking command. Setting
    // this environment variable disables the implicit current-directory lookup while
    // still honoring an explicit `.\tool.exe`.
    #[cfg(windows)]
    builder.env("NoDefaultCurrentDirectoryInExePath", "1");

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
            // A descendant that escaped the process group (setsid) survives the
            // kill and can hold the pipes open; abort the drains so they cannot
            // outlive the turn.
            stdout_task.abort();
            stderr_task.abort();
            return Err("cancelled".to_string());
        }
        _ = tokio::time::sleep(timeout) => {
            kill_tree(&mut child, pid).await;
            // A timeout is a recoverable tool error: include whatever the command
            // emitted before it stalled, which often shows *why* it hung. Snapshot the
            // captures before aborting the drains.
            let stdout = take_capture(&stdout_slot, !stdout_task.is_finished());
            let stderr = take_capture(&stderr_slot, !stderr_task.is_finished());
            stdout_task.abort();
            stderr_task.abort();
            let mut out = format!("command timed out after {}s", timeout.as_secs());
            push_stream(&mut out, "stdout", &render(stdout));
            push_stream(&mut out, "stderr", &render(stderr));
            return Err(out);
        }
    };

    let (stdout, stderr) =
        join_captured_pair(stdout_task, stdout_slot, stderr_task, stderr_slot, &cancel).await;
    let stdout_text = render(stdout);
    let stderr_text = render(stderr);

    if status.success() {
        // Exit 0: return stdout, appending a labelled stderr only if the command
        // wrote to it (warnings, progress).
        let mut out = stdout_text;
        push_stream(&mut out, "stderr", &stderr_text);
        Ok(out)
    } else {
        // Non-zero exit is a recoverable tool error: the model sees the code and
        // the output so it can react.
        let code = status
            .code()
            .map(|code| code.to_string())
            .unwrap_or_else(|| "terminated by signal".to_string());
        let mut out = format!("command exited with status {code}");
        push_stream(&mut out, "stdout", &stdout_text);
        push_stream(&mut out, "stderr", &stderr_text);
        Err(out)
    }
}

/// Append a labelled, non-empty stream section (`\n[label]\n<text>`) to a result or
/// error message. No-op for an empty stream, so a silent stream adds no noise.
fn push_stream(out: &mut String, label: &str, text: &str) {
    if !text.is_empty() {
        out.push_str("\n[");
        out.push_str(label);
        out.push_str("]\n");
        out.push_str(text);
    }
}

/// Read a stream to EOF into the shared slot, keeping the first [`CAPTURE_HEAD`]
/// bytes and the last [`CAPTURE_TAIL`] (a rolling window), but always draining the
/// rest (so the child never blocks on a full pipe). Writes into the slot
/// incrementally so an abandoned drain still leaves its capture behind.
async fn drain_capped<R: AsyncRead + Unpin>(mut reader: R, slot: CaptureSlot) {
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf).await {
            Ok(0) => break,
            Ok(read) => {
                let mut captured = lock_slot(&slot);
                let mut data = &buf[..read];
                // Fill the head first.
                if captured.head.len() < CAPTURE_HEAD {
                    let take = (CAPTURE_HEAD - captured.head.len()).min(data.len());
                    captured.head.extend_from_slice(&data[..take]);
                    data = &data[take..];
                }
                // Everything past the head rolls through the bounded tail window; a
                // byte pushed out of it is counted as dropped from the middle.
                for &byte in data {
                    if captured.tail.len() == CAPTURE_TAIL {
                        captured.tail.pop_front();
                        captured.dropped += 1;
                    }
                    captured.tail.push_back(byte);
                }
            }
            Err(_) => break,
        }
    }
}

/// Await both drain tasks concurrently under a single [`DRAIN_GRACE`] budget that
/// also observes cancellation. The child has already exited here, so a drain still
/// blocked can only be waiting on an orphan that inherited the pipe — abandon both
/// (marking each abandoned capture truncated) rather than pin the turn on a process
/// we chose not to kill, and still honor a Ctrl-C that lands during the wait.
///
/// Sharing one budget matters: awaiting the two serially would double the worst
/// case (each its own grace) and, once `child.wait()` had already won, would stop
/// observing cancellation entirely.
async fn join_captured_pair(
    mut stdout_task: tokio::task::JoinHandle<()>,
    stdout_slot: CaptureSlot,
    mut stderr_task: tokio::task::JoinHandle<()>,
    stderr_slot: CaptureSlot,
    cancel: &CancellationToken,
) -> (Captured, Captured) {
    let both = async {
        let _ = tokio::join!(&mut stdout_task, &mut stderr_task);
    };
    tokio::select! {
        _ = both => {}
        _ = tokio::time::sleep(DRAIN_GRACE) => {}
        _ = cancel.cancelled() => {}
    }
    // A drain that has not finished is still blocked reading a pipe a background
    // survivor (the child exited but left a descendant holding the write end) keeps
    // open. Mark that stream truncated so a clean stream keeps an accurate result —
    // but do NOT abort the drain: aborting drops the read end, and the next time the
    // survivor writes to stdout/stderr it takes `EPIPE`/`SIGPIPE` and can die, killing
    // the very background job this normal-exit path means to leave running. Instead
    // detach the drain (drop its handle without awaiting): it keeps consuming and
    // discarding the pipe until the survivor finally closes it, so it neither pins the
    // turn nor severs the pipe. The capture snapshot is already taken below.
    let stdout_abandoned = !stdout_task.is_finished();
    let stderr_abandoned = !stderr_task.is_finished();
    drop(stdout_task);
    drop(stderr_task);
    (
        take_capture(&stdout_slot, stdout_abandoned),
        take_capture(&stderr_slot, stderr_abandoned),
    )
}

/// Clone a slot's capture, OR-ing in an `abandoned` flag from the joiner on top of
/// whatever the drain already recorded.
fn take_capture(slot: &CaptureSlot, abandoned: bool) -> Captured {
    let captured = lock_slot(slot);
    Captured {
        head: captured.head.clone(),
        tail: captured.tail.clone(),
        dropped: captured.dropped,
        abandoned: captured.abandoned || abandoned,
    }
}

fn render(stream: Captured) -> String {
    let tail: Vec<u8> = stream.tail.into_iter().collect();
    let mut text = if stream.dropped == 0 {
        // Nothing dropped: head and tail are contiguous, so decode them as one buffer
        // (a multi-byte char spanning the boundary is not split).
        let mut all = stream.head;
        all.extend_from_slice(&tail);
        decode_output(&all)
    } else {
        // Head … omitted-middle marker … tail, so the actionable end survives.
        let mut out = decode_output(&stream.head);
        out.push_str(&format!("\n… [{} bytes omitted] …\n", stream.dropped));
        out.push_str(&decode_output(&tail));
        out
    };
    if stream.abandoned {
        text.push_str("\n… [truncated]");
    }
    text
}

/// Decode captured child output to text. Unix streams are UTF-8 by convention, so a
/// lossy decode is exactly right.
#[cfg(not(windows))]
fn decode_output(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// Decode captured child output on Windows using the code page the shell actually
/// wrote it in, rather than blindly assuming UTF-8.
///
/// `cmd`'s built-in commands (`echo`, `dir`) encode their output in the console
/// *output* code page — the value `GetConsoleOutputCP` reports — which on a legacy
/// system is an OEM page like 936 (GBK) or 932 (Shift-JIS), not UTF-8. Decoding those
/// bytes as UTF-8 turns every non-ASCII character into U+FFFD. This asks the system
/// which code page the child used and decodes with it, so the common case (a CLI's
/// console at its real code page) is correct.
///
/// This is not a guess: it reads the authoritative code page the writer used, unlike
/// the discarded "assume UTF-8, fall back on invalid bytes" heuristic (which a short
/// GBK run like `一` = `D2 BB` defeats, since those bytes are *also* valid UTF-8).
/// The one residual: a program that emits UTF-8 regardless of the console (rare — e.g.
/// `git` with `core.quotepath=false`; `git` defaults to ASCII-escaping) is misread on
/// a non-UTF-8 console. Fully removing even that needs a UTF-8 pseudo-console (ConPTY)
/// and is deferred; this stays side-effect-free and never touches the approved command.
#[cfg(windows)]
fn decode_output(bytes: &[u8]) -> String {
    use windows_sys::Win32::Globalization::{GetOEMCP, MultiByteToWideChar, CP_UTF8};
    use windows_sys::Win32::System::Console::GetConsoleOutputCP;

    if bytes.is_empty() {
        return String::new();
    }
    // The child (`cmd`) inherits this process's console, so its output code page is our
    // `GetConsoleOutputCP`. With no console attached (e.g. a GUI/Tauri host) that
    // returns 0; the child then spins up its own console at the system OEM page, so
    // fall back to `GetOEMCP`.
    // Safety: both calls take no arguments and only read process/console state.
    let code_page = match unsafe { GetConsoleOutputCP() } {
        0 => unsafe { GetOEMCP() },
        cp => cp,
    };
    if code_page == CP_UTF8 {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    // The API is `i32`-bounded; the capture cap keeps `bytes` far below `i32::MAX`, but
    // clamp defensively so a hypothetical oversized buffer can never wrap negative.
    let len = bytes.len().min(i32::MAX as usize) as i32;
    // Safety: first call measures the required wide length; `bytes`/`len` describe a
    // valid readable range and the output pointer is null with zero length.
    let wide_len =
        unsafe { MultiByteToWideChar(code_page, 0, bytes.as_ptr(), len, std::ptr::null_mut(), 0) };
    if wide_len <= 0 {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    let mut wide = vec![0u16; wide_len as usize];
    // Safety: `wide` has exactly `wide_len` slots, matching the count passed here; the
    // input range is the one measured above.
    let written = unsafe {
        MultiByteToWideChar(
            code_page,
            0,
            bytes.as_ptr(),
            len,
            wide.as_mut_ptr(),
            wide_len,
        )
    };
    if written <= 0 {
        return String::from_utf8_lossy(bytes).into_owned();
    }
    wide.truncate(written as usize);
    String::from_utf16_lossy(&wide)
}

/// Best-effort kill of the whole process tree. On unix, `SIGKILL` the negative
/// process-group id (set up via `process_group(0)`), then also `child.kill()` as a
/// fallback. On windows, `taskkill /T /F` terminates the pid's whole tree (the
/// `cmd` leader and anything it spawned), then `child.kill()` as a fallback.
/// Elsewhere only `child.kill()` is available.
async fn kill_tree(child: &mut Child, pid: Option<u32>) {
    #[cfg(unix)]
    if let Some(pid) = pid {
        // Safety: `kill(2)` with a negative pid signals the process group. A stale
        // pid at worst signals nothing; it cannot corrupt our address space.
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    #[cfg(windows)]
    if let Some(pid) = pid {
        // Windows has no process-group signal; `taskkill /T` walks the pid tree and
        // `/F` forces termination. Best-effort, mirroring the unix group kill: its
        // own output is discarded and a failure falls through to `child.kill()`.
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .await;
    }
    #[cfg(not(any(unix, windows)))]
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

    /// A command that runs long enough (~30s) to be killed by a short timeout or a
    /// cancel. Unix has `sleep`; windows has no `sleep` builtin, so a 31-ping loop
    /// (~30s at one ping/second) stands in.
    fn long_running() -> &'static str {
        #[cfg(unix)]
        {
            "sleep 30"
        }
        #[cfg(windows)]
        {
            "ping -n 31 127.0.0.1"
        }
    }

    /// A command that writes to both stdout and stderr, so capture + `[stderr]`
    /// labelling can be checked. The command separator differs: `;` on unix, `&` on
    /// windows `cmd`.
    fn writes_both_streams() -> &'static str {
        #[cfg(unix)]
        {
            "echo out; echo err 1>&2"
        }
        #[cfg(windows)]
        {
            "echo out& echo err 1>&2"
        }
    }

    /// A command that reads stdin to EOF and then exits, proving a closed stdin does
    /// not hang the turn: `cat` on unix, `sort` on windows.
    fn reads_stdin() -> &'static str {
        #[cfg(unix)]
        {
            "cat"
        }
        #[cfg(windows)]
        {
            "sort"
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
            .run(&ctx(), &prepared(writes_both_streams()))
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
        // stdin is closed, so a stdin reader sees EOF and exits instead of hanging.
        let tool = ShellTool::new(Duration::from_secs(5));
        let out = tool.run(&ctx(), &prepared(reads_stdin())).await.unwrap();
        assert_eq!(out, "", "a stdin reader on empty input yields no output");
    }

    // Unix-only: the drain-cap logic is platform-agnostic Rust; a clean `yes | head`
    // flood exercises it without leaning on a fragile `cmd` output loop on windows.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread")]
    async fn large_output_is_truncated_but_command_completes() {
        // ~100 KiB of output, well past the 32 KiB cap: the drain keeps reading so
        // the command can finish, and the result keeps a head + tail with an
        // omitted-middle marker rather than dropping the ending.
        let tool = ShellTool::new(Duration::from_secs(10));
        let out = tool
            .run(&ctx(), &prepared("yes | head -c 100000"))
            .await
            .unwrap();
        assert!(
            out.contains("bytes omitted"),
            "over-cap output must carry the omitted-middle marker, got end: {:?}",
            &out[out.len().saturating_sub(80)..]
        );
        assert!(
            out.len() < MAX_SHELL_CAPTURE + 100,
            "captured output must stay near the cap, got {} bytes",
            out.len()
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    #[cfg(unix)]
    async fn truncation_keeps_the_actionable_tail() {
        // The failure a test runner prints last must survive truncation: emit a head
        // marker, a large filler past the cap, then a distinctive tail.
        let tool = ShellTool::new(Duration::from_secs(10));
        let script = "printf 'HEAD-MARKER '; yes | head -c 100000; printf ' TAIL-FAILURE'";
        let out = tool.run(&ctx(), &prepared(script)).await.unwrap();
        assert!(out.contains("HEAD-MARKER"), "head must survive: {out:.60}");
        assert!(
            out.trim_end().ends_with("TAIL-FAILURE"),
            "the actionable tail must survive truncation, got end: {:?}",
            &out[out.len().saturating_sub(60)..]
        );
    }

    // Unix-only: relies on `&` job-control backgrounding a `sleep` that inherits the
    // pipe. `cmd` has no equivalent one-liner; the abandon-drain logic it exercises
    // is platform-agnostic and covered here.
    #[cfg(unix)]
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
            .run(&ctx(), &prepared(long_running()))
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
        let call = prepared(long_running());
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

    #[cfg(unix)]
    #[tokio::test]
    async fn background_writer_survives_the_turn_ending() {
        // A survivor that writes to stdout *after* the foreground command returns must
        // not be killed by the drain being torn down. If the drain were aborted, that
        // write would hit a closed pipe (EPIPE/SIGPIPE) and the subshell would die
        // before the sentinel; detaching the drain keeps the pipe consumed so the
        // write succeeds. The existing `sleep`-based survivor test never writes, so it
        // cannot catch this. DRAIN_GRACE is 2s, so the survivor sleeps past it (3s) to
        // guarantee it still holds the pipe when the drain is abandoned.
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let sentinel = std::env::temp_dir().join(format!("pawwork-shell-survivor-{nanos}"));
        std::fs::remove_file(&sentinel).ok();
        let script = format!(
            "( sleep 3; echo late-output; echo ok > '{}' ) & echo fg",
            sentinel.display()
        );
        let tool = ShellTool::new(Duration::from_secs(30));
        let out = tool.run(&ctx(), &prepared(&script)).await.unwrap();
        assert!(out.contains("fg"), "foreground output expected, got: {out}");
        // The survivor wakes at ~3s and writes the sentinel; poll generously past that.
        let mut found = false;
        for _ in 0..40 {
            if sentinel.exists() {
                found = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        std::fs::remove_file(&sentinel).ok();
        assert!(
            found,
            "a background writer must survive writing to stdout after the turn ends"
        );
    }

    fn captured_from(bytes: &[u8]) -> Captured {
        Captured {
            head: bytes.to_vec(),
            tail: VecDeque::new(),
            dropped: 0,
            abandoned: false,
        }
    }

    #[test]
    fn render_passes_ascii_through_unchanged() {
        // ASCII decodes identically under every code page, so this holds on unix and
        // on windows regardless of the active console code page — unlike a hard-coded
        // multi-byte UTF-8 fixture, which windows decodes per code page.
        assert_eq!(
            render(captured_from(b"ok: build passed [42/42]")),
            "ok: build passed [42/42]"
        );
    }

    // Multi-byte UTF-8 is only guaranteed to round-trip where output is decoded as
    // UTF-8: unix always is. On windows `render` decodes with the active console code
    // page (`GetConsoleOutputCP`), so these exact UTF-8 bytes would decode differently
    // under a legacy code page — asserting them there would wrongly fail a local
    // `cargo test`.
    #[cfg(not(windows))]
    #[test]
    fn render_decodes_multibyte_utf8_output() {
        assert_eq!(
            render(captured_from("café — 日本語".as_bytes())),
            "café — 日本語"
        );
    }
}
