import { describe, expect, test } from "bun:test"
import { MessageID, SessionID } from "../../src/session/schema"
import { RunObservability } from "../../src/session/run-observability"

describe("RunObservability", () => {
  test("does not treat stream lifecycle events as provider progress", () => {
    expect(RunObservability.isProviderProgressEvent({ type: "start" })).toBe(false)
    expect(RunObservability.isProviderProgressEvent({ type: "finish-step" })).toBe(false)
    expect(RunObservability.isProviderProgressEvent({ type: "text-delta" })).toBe(true)
    expect(RunObservability.isProviderProgressEvent({ type: "tool-call" })).toBe(true)
  })

  test("does not use lifecycle-only stream events for provider-progress transport summaries", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_start_disconnect"),
      traceID: MessageID.make("msg_start_disconnect"),
      sessionID: SessionID.make("ses_start_disconnect"),
      messageID: MessageID.make("msg_start_disconnect"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })

    const attempt = recorder.beginAttempt({ attemptIndex: 1, at: 11, monotonicMs: 110 })
    if (RunObservability.isProviderProgressEvent({ type: "start" })) {
      recorder.recordProviderProgress({ attemptID: attempt.attemptID, at: 12, monotonicMs: 120 })
    }
    recorder.recordTransportFailure({
      attemptID: attempt.attemptID,
      at: 25,
      monotonicMs: 250,
      error: {
        name: "TypeError",
        message: "terminated",
        cause: { name: "SocketError", message: "other side closed", code: "UND_ERR_SOCKET" },
      },
      evidence: ["iterator_error"],
    })

    const summary = recorder.finalize({ completedAt: 26, monotonicMs: 260 })
    expect(summary.provider_progress_seen).toBe(false)
    expect(summary.attempts[0]?.provider_progress_seen).toBe(false)
    expect(String(summary.summary_key)).toBe("external_stream_disconnect.transport_failure")
  })

  test("classifies completed runs without failure as success", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_success"),
      traceID: MessageID.make("msg_success"),
      sessionID: SessionID.make("ses_success"),
      messageID: MessageID.make("msg_success"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })

    recorder.beginAttempt({ attemptIndex: 1, at: 11, monotonicMs: 110 })

    const summary = recorder.finalize({ completedAt: 20, monotonicMs: 200 })
    expect(summary.classification).toBe("success")
    expect(String(summary.summary_key)).toBe("success.completed")
    expect(summary.retry_safety).toEqual({
      recommendation: "unknown",
      confidence: "high",
      reason: "completed_without_failure",
      safety_scope: "user_visible_and_tool_side_effects",
    })
    expect(summary.error).toBeUndefined()
  })

  test("does not write attempt completed_at for text-only success", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_text_only_completion"),
      traceID: MessageID.make("msg_text_only_completion"),
      sessionID: SessionID.make("ses_text_only_completion"),
      messageID: MessageID.make("msg_text_only_completion"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })

    const attempt = recorder.beginAttempt({ attemptIndex: 1, at: 11, monotonicMs: 110 })
    recorder.recordVisibleOutput({ attemptID: attempt.attemptID, at: 12, monotonicMs: 120 })

    const summary = recorder.finalize({ completedAt: 20, monotonicMs: 200 })
    expect(summary.attempts[0]).not.toHaveProperty("completed_at")
    expect(summary.attempts[0]).not.toHaveProperty("last_tool_completed_at")
  })

  test("records tool completion with tool-specific attempt field", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_tool_completion"),
      traceID: MessageID.make("msg_tool_completion"),
      sessionID: SessionID.make("ses_tool_completion"),
      messageID: MessageID.make("msg_tool_completion"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })

    const attempt = recorder.beginAttempt({ attemptIndex: 1, at: 11, monotonicMs: 110 })
    recorder.recordToolExecutionStarted({
      attemptID: attempt.attemptID,
      at: 12,
      monotonicMs: 120,
      toolName: RunObservability.safeToolName("read"),
      effect: RunObservability.toolEffect("read"),
    })
    recorder.recordToolCompleted({ attemptID: attempt.attemptID, at: 13, monotonicMs: 130 })

    const summary = recorder.finalize({ completedAt: 20, monotonicMs: 200 })
    expect(summary.attempts[0]).not.toHaveProperty("completed_at")
    expect(summary.attempts[0]).toMatchObject({ last_tool_completed_at: 13 })
  })

  test("keeps tool completion timestamps scoped to their attempts", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_multi_attempt_completion"),
      traceID: MessageID.make("msg_multi_attempt_completion"),
      sessionID: SessionID.make("ses_multi_attempt_completion"),
      messageID: MessageID.make("msg_multi_attempt_completion"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })

    const first = recorder.beginAttempt({ attemptIndex: 1, at: 11, monotonicMs: 110 })
    recorder.recordToolCompleted({ attemptID: first.attemptID, at: 13, monotonicMs: 130 })
    const second = recorder.beginAttempt({ attemptIndex: 2, at: 20, monotonicMs: 200 })
    recorder.recordVisibleOutput({ attemptID: second.attemptID, at: 21, monotonicMs: 210 })

    const summary = recorder.finalize({ completedAt: 30, monotonicMs: 300 })
    expect(summary.attempts).toHaveLength(2)
    expect(summary.attempts[0]).toMatchObject({ last_tool_completed_at: 13 })
    expect(summary.attempts[1]).not.toHaveProperty("completed_at")
    expect(summary.attempts[1]).not.toHaveProperty("last_tool_completed_at")
  })

  test("classifies external stream disconnect from run-level aggregate facts", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_external"),
      traceID: MessageID.make("msg_external"),
      sessionID: SessionID.make("ses_external"),
      messageID: MessageID.make("msg_external"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })

    const attempt = recorder.beginAttempt({ attemptIndex: 1, at: 11, monotonicMs: 110 })
    recorder.recordProviderProgress({ attemptID: attempt.attemptID, at: 12, monotonicMs: 120 })
    recorder.recordTransportFailure({
      attemptID: attempt.attemptID,
      at: 25,
      monotonicMs: 250,
      error: {
        name: "TypeError",
        message: "terminated",
        cause: { name: "SocketError", message: "other side closed", code: "UND_ERR_SOCKET" },
      },
      evidence: ["provider_progress_seen", "iterator_error"],
    })

    const summary = recorder.finalize({ completedAt: 26, monotonicMs: 260 })
    expect(summary.classification).toBe("external_stream_disconnect")
    expect(String(summary.summary_key)).toBe("external_stream_disconnect.provider_progress_socket_closed")
    expect(summary.retry_safety).toEqual({
      recommendation: "candidate_safe_auto_retry",
      confidence: "medium",
      reason: "no_visible_output_or_tool_execution",
      safety_scope: "user_visible_and_tool_side_effects",
    })
    expect(summary.visible_output_seen).toBe(false)
    expect(summary.tool_execution_started).toBe(false)
    expect(summary.durations_ms.last_event_to_failure).toBe(130)
  })

  test("retry safety is denied when any earlier attempt emitted visible output", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_retry_aggregate"),
      traceID: MessageID.make("msg_retry_aggregate"),
      sessionID: SessionID.make("ses_retry_aggregate"),
      messageID: MessageID.make("msg_retry_aggregate"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })

    const first = recorder.beginAttempt({ attemptIndex: 1, at: 11, monotonicMs: 110 })
    recorder.recordVisibleOutput({ attemptID: first.attemptID, at: 12, monotonicMs: 120 })
    const second = recorder.beginAttempt({ attemptIndex: 2, at: 20, monotonicMs: 200 })
    recorder.recordTransportFailure({
      attemptID: second.attemptID,
      at: 21,
      monotonicMs: 210,
      error: { name: "TypeError", message: "terminated", cause: { code: "UND_ERR_SOCKET" } },
      evidence: ["iterator_error"],
    })

    const summary = recorder.finalize({ completedAt: 22, monotonicMs: 220 })
    expect(summary.attempts).toHaveLength(2)
    expect(summary.visible_output_seen).toBe(true)
    expect(summary.retry_safety.recommendation).toBe("do_not_auto_retry")
    expect(summary.retry_safety.reason).toBe("visible_output_seen")
  })

  test("classifies local scope close with missing lifecycle provenance separately from user cancel", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_scope_close"),
      traceID: MessageID.make("msg_scope_close"),
      sessionID: SessionID.make("ses_scope_close"),
      messageID: MessageID.make("msg_scope_close"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })
    recorder.recordScopeClosed({
      at: 20,
      monotonicMs: 200,
      source: "session.run_state.scope",
      reason: "scope_closed_without_cancel_meta",
      propagationPoint: "session.prompt.loop.onInterrupt",
    })

    const summary = recorder.finalize({ completedAt: 21, monotonicMs: 210 })
    expect(summary.classification).toBe("unknown_scope_close")
    expect(String(summary.summary_key)).toBe("unknown_scope_close.missing_lifecycle_provenance")
    expect(summary.missing_provenance).toEqual(["lifecycle.close_requested"])
    expect(summary.retry_safety.recommendation).toBe("do_not_auto_retry")
  })

  test("records tool execution effect facts conservatively", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_tool_effects"),
      traceID: MessageID.make("msg_tool_effects"),
      sessionID: SessionID.make("ses_tool_effects"),
      messageID: MessageID.make("msg_tool_effects"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })
    const attempt = recorder.beginAttempt({ attemptIndex: 1, at: 11, monotonicMs: 110 })

    recorder.recordToolExecutionStarted({
      attemptID: attempt.attemptID,
      at: 12,
      monotonicMs: 120,
      toolName: RunObservability.safeToolName("bash /Users/alice/.ssh/id_rsa?token=secret"),
      effect: RunObservability.toolEffect("bash"),
    })
    recorder.recordToolInterrupted({ attemptID: attempt.attemptID, at: 13, monotonicMs: 130 })

    const summary = recorder.finalize({ completedAt: 14, monotonicMs: 140 })
    expect(summary.tool_execution_started).toBe(true)
    expect(summary.unsafe_side_effect_started).toBe(true)
    expect(summary.unsafe_side_effect_kinds).toEqual(["local_process"])
    expect(summary.side_effect_facts_complete).toBe(true)
    expect(JSON.stringify(summary)).not.toContain("/Users/alice")
    expect(JSON.stringify(summary)).not.toContain("secret")
  })

  test("redacts arbitrary error messages to low-cardinality values", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_safe_error"),
      traceID: MessageID.make("msg_safe_error"),
      sessionID: SessionID.make("ses_safe_error"),
      messageID: MessageID.make("msg_safe_error"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })
    const attempt = recorder.beginAttempt({ attemptIndex: 1, at: 11, monotonicMs: 110 })
    recorder.recordTransportFailure({
      attemptID: attempt.attemptID,
      at: 12,
      monotonicMs: 120,
      error: {
        name: "TypeError",
        message: "private prompt: email alice@example.com password=hunter2 file C:\\Users\\Alice\\secret.txt",
        cause: { message: "api_key=secret and /var/private/project/file.ts" },
      },
    })

    const summary = recorder.finalize({ completedAt: 13, monotonicMs: 130 })
    expect(summary.error?.message).toBe("redacted")
    expect(summary.error?.cause_message).toBe("redacted")
    const serialized = JSON.stringify(summary)
    expect(serialized).not.toContain("alice@example.com")
    expect(serialized).not.toContain("hunter2")
    expect(serialized).not.toContain("api_key")
    expect(serialized).not.toContain("secret.txt")
  })

  test("does not let generic transport handling overwrite tool or setup failure provenance", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_precedence"),
      traceID: MessageID.make("msg_precedence"),
      sessionID: SessionID.make("ses_precedence"),
      messageID: MessageID.make("msg_precedence"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })
    const attempt = recorder.beginAttempt({ attemptIndex: 1, at: 11, monotonicMs: 110 })
    recorder.recordToolFailed({
      attemptID: attempt.attemptID,
      at: 12,
      monotonicMs: 120,
      error: new Error("tool failed"),
    })
    recorder.recordTransportFailure({
      attemptID: attempt.attemptID,
      at: 13,
      monotonicMs: 130,
      error: new Error("terminated"),
    })

    const summary = recorder.finalize({ completedAt: 14, monotonicMs: 140 })
    expect(summary.classification).toBe("tool_failure")
    expect(summary.summary_key).toBe(RunObservability.summaryKeyFor("tool_failure", "tool_execution_failed"))
  })

  test("monotonic durations never go negative when wall clock moves backward", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_clock"),
      traceID: MessageID.make("msg_clock"),
      sessionID: SessionID.make("ses_clock"),
      messageID: MessageID.make("msg_clock"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 1_000,
      monotonicStartMs: 500,
    })
    const attempt = recorder.beginAttempt({ attemptIndex: 1, at: 900, monotonicMs: 510 })
    recorder.recordProviderProgress({ attemptID: attempt.attemptID, at: 800, monotonicMs: 520 })
    recorder.recordTransportFailure({
      attemptID: attempt.attemptID,
      at: 700,
      monotonicMs: 515,
      error: { name: "TypeError", message: "terminated" },
      evidence: ["iterator_error"],
    })

    const summary = recorder.finalize({ completedAt: 600, monotonicMs: 505 })
    expect(summary.durations_ms.total).toBe(5)
    expect(summary.durations_ms.last_event_to_failure).toBe(0)
  })
})
