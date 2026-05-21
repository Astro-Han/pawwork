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
      toolName: RunObservability.safeToolName("bash /Users/alice/.ssh/id_rsa?token=secret"),
      effect: RunObservability.toolEffect("bash"),
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

  test("derives provider transport incident during partial tool input instead of tool failure", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_partial_tool_input_disconnect"),
      traceID: MessageID.make("msg_partial_tool_input_disconnect"),
      sessionID: SessionID.make("ses_partial_tool_input_disconnect"),
      messageID: MessageID.make("msg_partial_tool_input_disconnect"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })

    const attempt = recorder.beginAttempt({ attemptIndex: 1, at: 11, monotonicMs: 110 })
    recorder.recordProviderProgress({ attemptID: attempt.attemptID, at: 12, monotonicMs: 120 })
    recorder.recordVisibleOutput({ attemptID: attempt.attemptID, at: 13, monotonicMs: 130 })
    recorder.recordToolInputStarted({ attemptID: attempt.attemptID, at: 14, monotonicMs: 140 })
    recorder.recordTransportFailure({
      attemptID: attempt.attemptID,
      at: 15,
      monotonicMs: 150,
      error: {
        name: "TypeError",
        message: "terminated",
        cause: { name: "SocketError", message: "other side closed", code: "UND_ERR_SOCKET" },
      },
      evidence: ["iterator_error"],
    })
    recorder.recordPendingToolPartInterrupted({ attemptID: attempt.attemptID, at: 16, monotonicMs: 160 })
    recorder.recordScopeClosed({
      at: 17,
      monotonicMs: 170,
      source: "session.run_state.finalizer",
      reason: "scope_finalizer",
      lifecycleActionID: "lifecycle:instance_reload:late",
      lifecycleKind: "instance_reload",
    })

    const summary = recorder.finalize({ completedAt: 18, monotonicMs: 180 })
    expect(summary.classification).not.toBe("tool_failure")
    expect(summary.tool_input_started).toBe(true)
    expect(summary.tool_input_completed).toBe(false)
    expect(summary.tool_call_materialized).toBe(false)
    expect(summary.tool_execution_started).toBe(false)
    expect(summary.pending_tool_parts_interrupted).toBe(1)
    expect(summary.incident?.terminal_cause).toMatchObject({
      category: "provider_transport_disconnect",
      subcategory: "during_tool_input_generation",
      boundary: "sdk_transport",
      confidence: "high",
    })
    expect(summary.incident?.phase).toMatchObject({
      run_phase: "tool_generation",
      stream_phase: "tool_input_generation",
      tool_phase: "tool_input_started",
      terminal_attempt_id: attempt.attemptID,
    })
    expect(summary.incident?.recovery).toMatchObject({
      recommendation: "offer_continue",
      reason: "partial_tool_input_without_execution",
    })
    expect(summary.incident?.evidence?.map((event) => event.event_type)).toEqual([
      "attempt_started",
      "provider_progress_seen",
      "text_output_started",
      "visible_output_seen",
      "tool_input_started",
      "provider_transport_failure",
      "pending_tool_part_interrupted",
      "lifecycle_close_seen",
    ])
  })

  test("does not promote pending tool cleanup to tool execution interruption without execution evidence", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_pending_tool_cleanup_guard"),
      traceID: MessageID.make("msg_pending_tool_cleanup_guard"),
      sessionID: SessionID.make("ses_pending_tool_cleanup_guard"),
      messageID: MessageID.make("msg_pending_tool_cleanup_guard"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })

    const attempt = recorder.beginAttempt({ attemptIndex: 1, at: 11, monotonicMs: 110 })
    recorder.recordToolInputStarted({ attemptID: attempt.attemptID, at: 12, monotonicMs: 120 })
    recorder.recordToolInterrupted({ attemptID: attempt.attemptID, at: 13, monotonicMs: 130 })

    const summary = recorder.finalize({ completedAt: 14, monotonicMs: 140 })
    expect(summary.classification).not.toBe("tool_failure")
    expect(summary.tool_execution_started).toBe(false)
    expect(summary.pending_tool_parts_interrupted).toBe(1)
    expect(summary.incident).toBeUndefined()
  })

  test("keeps tool execution interruption when execution evidence exists", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_tool_execution_cleanup_guard"),
      traceID: MessageID.make("msg_tool_execution_cleanup_guard"),
      sessionID: SessionID.make("ses_tool_execution_cleanup_guard"),
      messageID: MessageID.make("msg_tool_execution_cleanup_guard"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })

    const attempt = recorder.beginAttempt({ attemptIndex: 1, at: 11, monotonicMs: 110 })
    recorder.recordToolInputStarted({ attemptID: attempt.attemptID, at: 12, monotonicMs: 120 })
    recorder.recordToolInputCompleted({ attemptID: attempt.attemptID, at: 13, monotonicMs: 130 })
    recorder.recordToolCallMaterialized({
      attemptID: attempt.attemptID,
      at: 14,
      monotonicMs: 140,
      toolName: RunObservability.safeToolName("bash"),
      effect: RunObservability.toolEffect("bash"),
    })
    recorder.recordToolExecutionStarted({
      attemptID: attempt.attemptID,
      at: 15,
      monotonicMs: 150,
      toolName: RunObservability.safeToolName("bash"),
      effect: RunObservability.toolEffect("bash"),
    })
    recorder.recordToolInterrupted({ attemptID: attempt.attemptID, at: 16, monotonicMs: 160 })

    const summary = recorder.finalize({ completedAt: 17, monotonicMs: 170 })
    expect(summary.classification).toBe("tool_failure")
    expect(summary.tool_execution_started).toBe(true)
    expect(summary.incident?.terminal_cause.category).toBe("tool_execution_interrupted")
  })

  test("marks diagnostics incomplete for unknown side-effect and impossible tool evidence combinations", () => {
    const unknownBoundary = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_unknown_boundary"),
      traceID: MessageID.make("msg_unknown_boundary"),
      sessionID: SessionID.make("ses_unknown_boundary"),
      messageID: MessageID.make("msg_unknown_boundary"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })
    const unknownAttempt = unknownBoundary.beginAttempt({ attemptIndex: 1, at: 11, monotonicMs: 110 })
    unknownBoundary.recordToolCallMaterialized({ attemptID: unknownAttempt.attemptID, at: 12, monotonicMs: 120 })
    unknownBoundary.recordTransportFailure({
      attemptID: unknownAttempt.attemptID,
      at: 13,
      monotonicMs: 130,
      error: new Error("boom"),
    })
    const unknownSummary = unknownBoundary.finalize({ completedAt: 14, monotonicMs: 140 })
    expect(unknownSummary.incident?.diagnostics_complete).toBe(false)
    expect(unknownSummary.incident?.missing_provenance).toContain("side_effect.boundary_unknown")

    const executionWithoutCall = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_execution_without_call"),
      traceID: MessageID.make("msg_execution_without_call"),
      sessionID: SessionID.make("ses_execution_without_call"),
      messageID: MessageID.make("msg_execution_without_call"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })
    const executionAttempt = executionWithoutCall.beginAttempt({ attemptIndex: 1, at: 11, monotonicMs: 110 })
    executionWithoutCall.recordToolExecutionStarted({
      attemptID: executionAttempt.attemptID,
      at: 12,
      monotonicMs: 120,
      toolName: RunObservability.safeToolName("bash"),
      effect: RunObservability.toolEffect("bash"),
    })
    executionWithoutCall.recordToolInterrupted({ attemptID: executionAttempt.attemptID, at: 13, monotonicMs: 130 })
    const executionSummary = executionWithoutCall.finalize({ completedAt: 14, monotonicMs: 140 })
    expect(executionSummary.incident?.diagnostics_complete).toBe(false)
    expect(executionSummary.incident?.missing_provenance).toContain("tool.materialization_missing")

    const inputWithoutStart = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_input_without_start"),
      traceID: MessageID.make("msg_input_without_start"),
      sessionID: SessionID.make("ses_input_without_start"),
      messageID: MessageID.make("msg_input_without_start"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })
    const inputAttempt = inputWithoutStart.beginAttempt({ attemptIndex: 1, at: 11, monotonicMs: 110 })
    inputWithoutStart.recordToolInputCompleted({ attemptID: inputAttempt.attemptID, at: 12, monotonicMs: 120 })
    inputWithoutStart.recordTransportFailure({
      attemptID: inputAttempt.attemptID,
      at: 13,
      monotonicMs: 130,
      error: new Error("boom"),
    })
    const inputSummary = inputWithoutStart.finalize({ completedAt: 14, monotonicMs: 140 })
    expect(inputSummary.incident?.diagnostics_complete).toBe(false)
    expect(inputSummary.incident?.missing_provenance).toContain("tool_input.start_missing")
  })

  test("bounded incident evidence keeps terminal and cleanup basis after long output", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_long_output_disconnect"),
      traceID: MessageID.make("msg_long_output_disconnect"),
      sessionID: SessionID.make("ses_long_output_disconnect"),
      messageID: MessageID.make("msg_long_output_disconnect"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })

    const attempt = recorder.beginAttempt({ attemptIndex: 1, at: 11, monotonicMs: 110 })
    for (let i = 0; i < 20; i++) {
      recorder.recordProviderProgress({ attemptID: attempt.attemptID, at: 12 + i, monotonicMs: 120 + i * 10 })
      recorder.recordVisibleOutput({ attemptID: attempt.attemptID, at: 12 + i, monotonicMs: 121 + i * 10 })
    }
    recorder.recordTransportFailure({
      attemptID: attempt.attemptID,
      at: 40,
      monotonicMs: 400,
      error: { name: "TypeError", message: "terminated", cause: { code: "UND_ERR_SOCKET" } },
      evidence: ["iterator_error"],
    })
    recorder.recordPendingToolPartInterrupted({ attemptID: attempt.attemptID, at: 41, monotonicMs: 410 })
    recorder.recordScopeClosed({
      at: 42,
      monotonicMs: 420,
      source: "session.run_state.finalizer",
      reason: "scope_finalizer",
      lifecycleActionID: "lifecycle:instance_reload:long-output",
      lifecycleKind: "instance_reload",
    })

    const evidence = recorder.finalize({ completedAt: 43, monotonicMs: 430 }).incident?.evidence ?? []
    expect(evidence.length).toBeLessThanOrEqual(24)
    expect(evidence.some((event) => event.event_type === "evidence_omitted" && event.omitted_events)).toBe(true)
    expect(evidence.map((event) => event.event_type)).toContain("provider_transport_failure")
    expect(evidence.map((event) => event.event_type)).toContain("pending_tool_part_interrupted")
    expect(evidence.map((event) => event.event_type)).toContain("lifecycle_close_seen")
    expect(evidence.map((event) => event.event_type).slice(-3)).toEqual([
      "provider_transport_failure",
      "pending_tool_part_interrupted",
      "lifecycle_close_seen",
    ])
  })

  test("bounded incident evidence keeps newest terminal and cleanup anchors when anchors exceed cap", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_many_terminal_anchors"),
      traceID: MessageID.make("msg_many_terminal_anchors"),
      sessionID: SessionID.make("ses_many_terminal_anchors"),
      messageID: MessageID.make("msg_many_terminal_anchors"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })
    const attempt = recorder.beginAttempt({ attemptIndex: 1, at: 11, monotonicMs: 110 })
    for (let i = 0; i < 30; i++) {
      recorder.recordToolFailed({
        attemptID: attempt.attemptID,
        at: 12 + i,
        monotonicMs: 120 + i,
        error: new Error(`tool failed ${i}`),
      })
    }
    recorder.recordPendingToolPartInterrupted({ attemptID: attempt.attemptID, at: 50, monotonicMs: 500 })
    recorder.recordScopeClosed({
      at: 51,
      monotonicMs: 510,
      lifecycleActionID: "lifecycle:instance_reload:many-terminal-anchors",
      lifecycleKind: "instance_reload",
    })

    const evidence = recorder.finalize({ completedAt: 52, monotonicMs: 520 }).incident?.evidence ?? []
    expect(evidence.length).toBeLessThanOrEqual(24)
    expect(evidence.some((event) => event.event_type === "evidence_omitted" && event.omitted_events)).toBe(true)
    expect(evidence.map((event) => event.event_type)).toContain("pending_tool_part_interrupted")
    expect(evidence.map((event) => event.event_type)).toContain("lifecycle_close_seen")
    expect(evidence.at(-1)?.event_type).toBe("lifecycle_close_seen")
  })

  test("orders terminal cause by initiating evidence time", () => {
    const providerFirst = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_provider_first"),
      traceID: MessageID.make("msg_provider_first"),
      sessionID: SessionID.make("ses_provider_first"),
      messageID: MessageID.make("msg_provider_first"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })
    const providerAttempt = providerFirst.beginAttempt({ attemptIndex: 1, at: 11, monotonicMs: 110 })
    providerFirst.recordProviderProgress({ attemptID: providerAttempt.attemptID, at: 12, monotonicMs: 120 })
    providerFirst.recordTransportFailure({
      attemptID: providerAttempt.attemptID,
      at: 13,
      monotonicMs: 130,
      error: { name: "TypeError", message: "terminated", cause: { code: "UND_ERR_SOCKET" } },
    })
    providerFirst.recordScopeClosed({
      at: 14,
      monotonicMs: 140,
      lifecycleActionID: "lifecycle:instance_reload:after_provider",
      lifecycleKind: "instance_reload",
    })
    expect(providerFirst.finalize({ completedAt: 15, monotonicMs: 150 }).incident?.terminal_cause.category).toBe(
      "provider_transport_disconnect",
    )

    const lifecycleFirst = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_lifecycle_first"),
      traceID: MessageID.make("msg_lifecycle_first"),
      sessionID: SessionID.make("ses_lifecycle_first"),
      messageID: MessageID.make("msg_lifecycle_first"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })
    const lifecycleAttempt = lifecycleFirst.beginAttempt({ attemptIndex: 1, at: 11, monotonicMs: 110 })
    lifecycleFirst.recordScopeClosed({
      at: 12,
      monotonicMs: 120,
      lifecycleActionID: "lifecycle:instance_reload:before_provider_abort",
      lifecycleKind: "instance_reload",
    })
    lifecycleFirst.recordTransportFailure({
      attemptID: lifecycleAttempt.attemptID,
      at: 13,
      monotonicMs: 130,
      error: { name: "AbortError", message: "aborted" },
    })
    expect(lifecycleFirst.finalize({ completedAt: 14, monotonicMs: 140 }).incident?.terminal_cause).toMatchObject({
      category: "local_lifecycle_close",
      subcategory: "instance_reload",
    })
  })

  test("cleanup events do not overwrite earlier lifecycle provenance", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_lifecycle_then_cleanup"),
      traceID: MessageID.make("msg_lifecycle_then_cleanup"),
      sessionID: SessionID.make("ses_lifecycle_then_cleanup"),
      messageID: MessageID.make("msg_lifecycle_then_cleanup"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })
    const attempt = recorder.beginAttempt({ attemptIndex: 1, at: 11, monotonicMs: 110 })
    recorder.recordScopeClosed({
      at: 12,
      monotonicMs: 120,
      source: "session.run_state.scope",
      reason: "scope_closed_without_cancel_meta",
    })
    recorder.recordToolInterrupted({ attemptID: attempt.attemptID, at: 13, monotonicMs: 130 })
    recorder.recordTransportFailure({
      attemptID: attempt.attemptID,
      at: 14,
      monotonicMs: 140,
      error: { name: "AbortError", message: "aborted" },
    })

    const summary = recorder.finalize({ completedAt: 15, monotonicMs: 150 })
    expect(summary.classification).toBe("unknown_scope_close")
    expect(summary.incident?.terminal_cause).toMatchObject({
      category: "local_lifecycle_close",
      subcategory: "unknown_lifecycle_close",
    })
    expect(summary.missing_provenance).toEqual(["lifecycle.close_requested"])
    expect(summary.incident?.missing_provenance).toEqual(["lifecycle.close_requested"])
    expect(summary.incident?.diagnostics_complete).toBe(false)
  })

  test("cleanup events do not overwrite earlier setup failures", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_setup_then_cleanup"),
      traceID: MessageID.make("msg_setup_then_cleanup"),
      sessionID: SessionID.make("ses_setup_then_cleanup"),
      messageID: MessageID.make("msg_setup_then_cleanup"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })
    const attempt = recorder.beginAttempt({ attemptIndex: 1, at: 11, monotonicMs: 110 })
    recorder.recordSetupFailure({ at: 12, monotonicMs: 120, error: new Error("setup failed") })
    recorder.recordToolFailed({ attemptID: attempt.attemptID, at: 13, monotonicMs: 130, error: new Error("cleanup") })
    recorder.recordTransportFailure({
      attemptID: attempt.attemptID,
      at: 14,
      monotonicMs: 140,
      error: { name: "AbortError", message: "aborted" },
    })

    const summary = recorder.finalize({ completedAt: 15, monotonicMs: 150 })
    expect(summary.classification).toBe("request_setup_failure")
    expect(summary.incident?.terminal_cause.category).toBe("request_setup_failure")
    expect(summary.error?.message).toBe("redacted")
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

  test("terminal attempt facts drive transport cause while run facts drive recovery safety", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_attempt_scoped_terminal"),
      traceID: MessageID.make("msg_attempt_scoped_terminal"),
      sessionID: SessionID.make("ses_attempt_scoped_terminal"),
      messageID: MessageID.make("msg_attempt_scoped_terminal"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })
    const first = recorder.beginAttempt({ attemptIndex: 1, at: 11, monotonicMs: 110 })
    recorder.recordVisibleOutput({ attemptID: first.attemptID, at: 12, monotonicMs: 120 })
    recorder.recordToolInputStarted({ attemptID: first.attemptID, at: 13, monotonicMs: 130 })
    const second = recorder.beginAttempt({ attemptIndex: 2, at: 20, monotonicMs: 200 })
    recorder.recordProviderProgress({ attemptID: second.attemptID, at: 21, monotonicMs: 210 })
    recorder.recordTransportFailure({
      attemptID: second.attemptID,
      at: 22,
      monotonicMs: 220,
      error: { name: "TypeError", message: "terminated", cause: { code: "UND_ERR_SOCKET" } },
    })

    const summary = recorder.finalize({ completedAt: 23, monotonicMs: 230 })
    expect(summary.incident?.terminal_cause).toMatchObject({
      category: "provider_transport_disconnect",
      subcategory: "during_text_generation",
    })
    expect(summary.incident?.phase).toMatchObject({
      stream_phase: "text_generation",
      tool_phase: "none",
      terminal_attempt_id: second.attemptID,
    })
    expect(summary.incident?.recovery).toMatchObject({
      recommendation: "offer_continue",
      reason: "visible_output_without_tool_execution",
    })
  })

  test("provider-executed tool boundaries make recovery conservative", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_provider_executed_boundary"),
      traceID: MessageID.make("msg_provider_executed_boundary"),
      sessionID: SessionID.make("ses_provider_executed_boundary"),
      messageID: MessageID.make("msg_provider_executed_boundary"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })
    const attempt = recorder.beginAttempt({ attemptIndex: 1, at: 11, monotonicMs: 110 })
    recorder.recordToolInputStarted({ attemptID: attempt.attemptID, at: 12, monotonicMs: 120, providerExecuted: true })
    recorder.recordTransportFailure({
      attemptID: attempt.attemptID,
      at: 13,
      monotonicMs: 130,
      error: { name: "TypeError", message: "terminated", cause: { code: "UND_ERR_SOCKET" } },
    })

    const summary = recorder.finalize({ completedAt: 14, monotonicMs: 140 })
    expect(summary.side_effect_facts_complete).toBe(false)
    expect(summary.incident?.facts.side_effect_facts_complete).toBe(false)
    expect(summary.incident?.recovery).toMatchObject({
      recommendation: "ask_user_before_retry",
      reason: "side_effect_facts_incomplete",
    })
    expect(summary.incident?.evidence?.map((event) => event.event_type)).toContain("provider_executed_tool_boundary")
  })

  test("transport failure after tool input end is not classified as text generation", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_after_tool_input_end"),
      traceID: MessageID.make("msg_after_tool_input_end"),
      sessionID: SessionID.make("ses_after_tool_input_end"),
      messageID: MessageID.make("msg_after_tool_input_end"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })
    const attempt = recorder.beginAttempt({ attemptIndex: 1, at: 11, monotonicMs: 110 })
    recorder.recordToolInputStarted({ attemptID: attempt.attemptID, at: 12, monotonicMs: 120 })
    recorder.recordToolInputCompleted({ attemptID: attempt.attemptID, at: 13, monotonicMs: 130 })
    recorder.recordTransportFailure({
      attemptID: attempt.attemptID,
      at: 14,
      monotonicMs: 140,
      error: { name: "TypeError", message: "terminated", cause: { code: "UND_ERR_SOCKET" } },
    })

    const summary = recorder.finalize({ completedAt: 15, monotonicMs: 150 })
    expect(summary.incident?.terminal_cause).toMatchObject({
      category: "provider_transport_disconnect",
      subcategory: "unknown_stream_phase",
    })
    expect(summary.incident?.phase).toMatchObject({
      stream_phase: "after_tool_input_end",
      tool_phase: "tool_input_completed",
    })
  })

  test("safe materialized tool call without execution can offer continue", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_safe_materialized_tool"),
      traceID: MessageID.make("msg_safe_materialized_tool"),
      sessionID: SessionID.make("ses_safe_materialized_tool"),
      messageID: MessageID.make("msg_safe_materialized_tool"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })
    const attempt = recorder.beginAttempt({ attemptIndex: 1, at: 11, monotonicMs: 110 })
    recorder.recordToolInputStarted({ attemptID: attempt.attemptID, at: 12, monotonicMs: 120 })
    recorder.recordToolInputCompleted({ attemptID: attempt.attemptID, at: 13, monotonicMs: 130 })
    recorder.recordToolCallMaterialized({
      attemptID: attempt.attemptID,
      at: 14,
      monotonicMs: 140,
      toolName: RunObservability.safeToolName("read"),
      effect: RunObservability.toolEffect("read"),
    })
    recorder.recordTransportFailure({
      attemptID: attempt.attemptID,
      at: 15,
      monotonicMs: 150,
      error: { name: "TypeError", message: "terminated", cause: { code: "UND_ERR_SOCKET" } },
    })

    const summary = recorder.finalize({ completedAt: 16, monotonicMs: 160 })
    expect(summary.incident?.recovery).toMatchObject({
      recommendation: "offer_continue",
      reason: "tool_call_materialized_without_execution",
    })
    expect(summary.incident?.facts).toMatchObject({
      materialized_tool_effect_kind: "read_only",
      materialized_tool_requires_confirmation: false,
    })
    expect(summary.incident?.evidence?.find((event) => event.event_type === "tool_call_materialized")).toMatchObject({
      tool_name: RunObservability.safeToolName("read"),
      tool_effect_kind: "read_only",
      tool_effect_unsafe: false,
      tool_effect_complete: true,
    })
  })

  test("unsafe materialized tool call without execution requires confirmation", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_unsafe_materialized_tool"),
      traceID: MessageID.make("msg_unsafe_materialized_tool"),
      sessionID: SessionID.make("ses_unsafe_materialized_tool"),
      messageID: MessageID.make("msg_unsafe_materialized_tool"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })
    const attempt = recorder.beginAttempt({ attemptIndex: 1, at: 11, monotonicMs: 110 })
    recorder.recordToolCallMaterialized({
      attemptID: attempt.attemptID,
      at: 12,
      monotonicMs: 120,
      toolName: RunObservability.safeToolName("bash"),
      effect: RunObservability.toolEffect("bash"),
    })
    recorder.recordTransportFailure({
      attemptID: attempt.attemptID,
      at: 13,
      monotonicMs: 130,
      error: { name: "TypeError", message: "terminated", cause: { code: "UND_ERR_SOCKET" } },
    })

    const summary = recorder.finalize({ completedAt: 14, monotonicMs: 140 })
    expect(summary.incident?.recovery).toMatchObject({
      recommendation: "ask_user_before_retry",
      reason: "tool_call_materialized_without_execution",
    })
    expect(summary.incident?.facts).toMatchObject({
      materialized_tool_effect_kind: "local_process",
      materialized_tool_requires_confirmation: true,
    })
  })

  test("unknown materialized tool call without execution requires confirmation", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_unknown_materialized_tool"),
      traceID: MessageID.make("msg_unknown_materialized_tool"),
      sessionID: SessionID.make("ses_unknown_materialized_tool"),
      messageID: MessageID.make("msg_unknown_materialized_tool"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })
    const attempt = recorder.beginAttempt({ attemptIndex: 1, at: 11, monotonicMs: 110 })
    recorder.recordToolCallMaterialized({
      attemptID: attempt.attemptID,
      at: 12,
      monotonicMs: 120,
      toolName: RunObservability.safeToolName("mcp_write"),
      effect: RunObservability.toolEffect("mcp_write"),
    })
    recorder.recordTransportFailure({
      attemptID: attempt.attemptID,
      at: 13,
      monotonicMs: 130,
      error: { name: "TypeError", message: "terminated", cause: { code: "UND_ERR_SOCKET" } },
    })

    const summary = recorder.finalize({ completedAt: 14, monotonicMs: 140 })
    expect(summary.incident?.recovery).toMatchObject({
      recommendation: "ask_user_before_retry",
      reason: "side_effect_facts_incomplete",
    })
    expect(summary.incident?.facts).toMatchObject({
      materialized_tool_effect_kind: "unknown",
      materialized_tool_requires_confirmation: true,
    })
  })

  test("missing materialized tool effect requires confirmation", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_missing_materialized_effect"),
      traceID: MessageID.make("msg_missing_materialized_effect"),
      sessionID: SessionID.make("ses_missing_materialized_effect"),
      messageID: MessageID.make("msg_missing_materialized_effect"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })
    const attempt = recorder.beginAttempt({ attemptIndex: 1, at: 11, monotonicMs: 110 })
    recorder.recordToolCallMaterialized({ attemptID: attempt.attemptID, at: 12, monotonicMs: 120 })
    recorder.recordTransportFailure({
      attemptID: attempt.attemptID,
      at: 13,
      monotonicMs: 130,
      error: { name: "TypeError", message: "terminated", cause: { code: "UND_ERR_SOCKET" } },
    })

    const summary = recorder.finalize({ completedAt: 14, monotonicMs: 140 })
    expect(summary.incident?.recovery).toMatchObject({
      recommendation: "ask_user_before_retry",
      reason: "side_effect_facts_incomplete",
    })
    expect(summary.incident?.facts).toMatchObject({
      materialized_tool_effect_kind: "unknown",
      materialized_tool_requires_confirmation: true,
      side_effect_facts_complete: false,
    })
  })

  test("reasoning-only transport failure uses reasoning generation phase", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_reasoning_only_disconnect"),
      traceID: MessageID.make("msg_reasoning_only_disconnect"),
      sessionID: SessionID.make("ses_reasoning_only_disconnect"),
      messageID: MessageID.make("msg_reasoning_only_disconnect"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })
    const attempt = recorder.beginAttempt({ attemptIndex: 1, at: 11, monotonicMs: 110 })
    recorder.recordProviderProgress({ attemptID: attempt.attemptID, at: 12, monotonicMs: 120 })
    recorder.recordVisibleOutput({ attemptID: attempt.attemptID, at: 13, monotonicMs: 130, kind: "reasoning" })
    recorder.recordTransportFailure({
      attemptID: attempt.attemptID,
      at: 14,
      monotonicMs: 140,
      error: { name: "TypeError", message: "terminated", cause: { code: "UND_ERR_SOCKET" } },
    })

    const summary = recorder.finalize({ completedAt: 15, monotonicMs: 150 })
    expect(summary.incident?.facts).toMatchObject({
      reasoning_output_started: true,
      text_output_started: false,
    })
    expect(summary.incident?.phase.stream_phase).toBe("reasoning_generation")
  })

  test("materialized tool recovery keeps unsafe boundary even when a later safe tool materializes", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_unsafe_then_safe_materialized_tool"),
      traceID: MessageID.make("msg_unsafe_then_safe_materialized_tool"),
      sessionID: SessionID.make("ses_unsafe_then_safe_materialized_tool"),
      messageID: MessageID.make("msg_unsafe_then_safe_materialized_tool"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })
    const attempt = recorder.beginAttempt({ attemptIndex: 1, at: 11, monotonicMs: 110 })
    recorder.recordToolCallMaterialized({
      attemptID: attempt.attemptID,
      at: 12,
      monotonicMs: 120,
      toolName: RunObservability.safeToolName("bash"),
      effect: RunObservability.toolEffect("bash"),
    })
    recorder.recordToolCallMaterialized({
      attemptID: attempt.attemptID,
      at: 13,
      monotonicMs: 130,
      toolName: RunObservability.safeToolName("read"),
      effect: RunObservability.toolEffect("read"),
    })
    recorder.recordTransportFailure({
      attemptID: attempt.attemptID,
      at: 14,
      monotonicMs: 140,
      error: { name: "TypeError", message: "terminated", cause: { code: "UND_ERR_SOCKET" } },
    })

    const summary = recorder.finalize({ completedAt: 15, monotonicMs: 150 })
    expect(summary.incident?.recovery).toMatchObject({
      recommendation: "ask_user_before_retry",
      reason: "tool_call_materialized_without_execution",
    })
    expect(summary.incident?.facts).toMatchObject({
      materialized_tool_effect_kind: "local_process",
      materialized_tool_requires_confirmation: true,
    })
  })

  test("materialized tool recovery keeps unknown boundary even when a later safe tool materializes", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_unknown_then_safe_materialized_tool"),
      traceID: MessageID.make("msg_unknown_then_safe_materialized_tool"),
      sessionID: SessionID.make("ses_unknown_then_safe_materialized_tool"),
      messageID: MessageID.make("msg_unknown_then_safe_materialized_tool"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })
    const attempt = recorder.beginAttempt({ attemptIndex: 1, at: 11, monotonicMs: 110 })
    recorder.recordToolCallMaterialized({
      attemptID: attempt.attemptID,
      at: 12,
      monotonicMs: 120,
      toolName: RunObservability.safeToolName("mcp_write"),
      effect: RunObservability.toolEffect("mcp_write"),
    })
    recorder.recordToolCallMaterialized({
      attemptID: attempt.attemptID,
      at: 13,
      monotonicMs: 130,
      toolName: RunObservability.safeToolName("read"),
      effect: RunObservability.toolEffect("read"),
    })
    recorder.recordTransportFailure({
      attemptID: attempt.attemptID,
      at: 14,
      monotonicMs: 140,
      error: { name: "TypeError", message: "terminated", cause: { code: "UND_ERR_SOCKET" } },
    })

    const summary = recorder.finalize({ completedAt: 15, monotonicMs: 150 })
    expect(summary.incident?.recovery).toMatchObject({
      recommendation: "ask_user_before_retry",
      reason: "side_effect_facts_incomplete",
    })
    expect(summary.incident?.facts).toMatchObject({
      materialized_tool_effect_kind: "unknown",
      materialized_tool_requires_confirmation: true,
      side_effect_facts_complete: false,
    })
  })

  test("materialized tool recovery keeps unsafe boundary when unsafe tool materializes last", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_safe_then_unsafe_materialized_tool"),
      traceID: MessageID.make("msg_safe_then_unsafe_materialized_tool"),
      sessionID: SessionID.make("ses_safe_then_unsafe_materialized_tool"),
      messageID: MessageID.make("msg_safe_then_unsafe_materialized_tool"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })
    const attempt = recorder.beginAttempt({ attemptIndex: 1, at: 11, monotonicMs: 110 })
    recorder.recordToolCallMaterialized({
      attemptID: attempt.attemptID,
      at: 12,
      monotonicMs: 120,
      toolName: RunObservability.safeToolName("read"),
      effect: RunObservability.toolEffect("read"),
    })
    recorder.recordToolCallMaterialized({
      attemptID: attempt.attemptID,
      at: 13,
      monotonicMs: 130,
      toolName: RunObservability.safeToolName("bash"),
      effect: RunObservability.toolEffect("bash"),
    })
    recorder.recordTransportFailure({
      attemptID: attempt.attemptID,
      at: 14,
      monotonicMs: 140,
      error: { name: "TypeError", message: "terminated", cause: { code: "UND_ERR_SOCKET" } },
    })

    const summary = recorder.finalize({ completedAt: 15, monotonicMs: 150 })
    expect(summary.incident?.recovery).toMatchObject({
      recommendation: "ask_user_before_retry",
      reason: "tool_call_materialized_without_execution",
    })
    expect(summary.incident?.facts).toMatchObject({
      materialized_tool_effect_kind: "local_process",
      materialized_tool_requires_confirmation: true,
    })
  })

  test("earlier attempt unsafe materialized tool prevents later auto retry", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_cross_attempt_unsafe_materialized_tool"),
      traceID: MessageID.make("msg_cross_attempt_unsafe_materialized_tool"),
      sessionID: SessionID.make("ses_cross_attempt_unsafe_materialized_tool"),
      messageID: MessageID.make("msg_cross_attempt_unsafe_materialized_tool"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })
    const first = recorder.beginAttempt({ attemptIndex: 1, at: 11, monotonicMs: 110 })
    recorder.recordToolCallMaterialized({
      attemptID: first.attemptID,
      at: 12,
      monotonicMs: 120,
      toolName: RunObservability.safeToolName("bash"),
      effect: RunObservability.toolEffect("bash"),
    })
    const second = recorder.beginAttempt({ attemptIndex: 2, at: 20, monotonicMs: 200 })
    recorder.recordTransportFailure({
      attemptID: second.attemptID,
      at: 21,
      monotonicMs: 210,
      error: { name: "TypeError", message: "terminated", cause: { code: "UND_ERR_SOCKET" } },
    })

    const summary = recorder.finalize({ completedAt: 22, monotonicMs: 220 })
    expect(summary.incident?.terminal_cause).toMatchObject({
      category: "provider_transport_disconnect",
      subcategory: "before_first_provider_progress",
    })
    expect(summary.incident?.recovery).toMatchObject({
      recommendation: "ask_user_before_retry",
      reason: "tool_call_materialized_without_execution",
    })
  })

  test("earlier attempt safe materialized tool prevents later auto retry", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_cross_attempt_safe_materialized_tool"),
      traceID: MessageID.make("msg_cross_attempt_safe_materialized_tool"),
      sessionID: SessionID.make("ses_cross_attempt_safe_materialized_tool"),
      messageID: MessageID.make("msg_cross_attempt_safe_materialized_tool"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })
    const first = recorder.beginAttempt({ attemptIndex: 1, at: 11, monotonicMs: 110 })
    recorder.recordToolCallMaterialized({
      attemptID: first.attemptID,
      at: 12,
      monotonicMs: 120,
      toolName: RunObservability.safeToolName("read"),
      effect: RunObservability.toolEffect("read"),
    })
    const second = recorder.beginAttempt({ attemptIndex: 2, at: 20, monotonicMs: 200 })
    recorder.recordTransportFailure({
      attemptID: second.attemptID,
      at: 21,
      monotonicMs: 210,
      error: { name: "TypeError", message: "terminated", cause: { code: "UND_ERR_SOCKET" } },
    })

    const summary = recorder.finalize({ completedAt: 22, monotonicMs: 220 })
    expect(summary.incident?.recovery).toMatchObject({
      recommendation: "offer_continue",
      reason: "tool_call_materialized_without_execution",
    })
  })

  test("earlier attempt unknown materialized tool prevents later auto retry", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_cross_attempt_unknown_materialized_tool"),
      traceID: MessageID.make("msg_cross_attempt_unknown_materialized_tool"),
      sessionID: SessionID.make("ses_cross_attempt_unknown_materialized_tool"),
      messageID: MessageID.make("msg_cross_attempt_unknown_materialized_tool"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })
    const first = recorder.beginAttempt({ attemptIndex: 1, at: 11, monotonicMs: 110 })
    recorder.recordToolCallMaterialized({
      attemptID: first.attemptID,
      at: 12,
      monotonicMs: 120,
      toolName: RunObservability.safeToolName("mcp_write"),
      effect: RunObservability.toolEffect("mcp_write"),
    })
    const second = recorder.beginAttempt({ attemptIndex: 2, at: 20, monotonicMs: 200 })
    recorder.recordProviderProgress({ attemptID: second.attemptID, at: 21, monotonicMs: 210 })
    recorder.recordTransportFailure({
      attemptID: second.attemptID,
      at: 22,
      monotonicMs: 220,
      error: { name: "TypeError", message: "terminated", cause: { code: "UND_ERR_SOCKET" } },
    })

    const summary = recorder.finalize({ completedAt: 23, monotonicMs: 230 })
    expect(summary.incident?.recovery).toMatchObject({
      recommendation: "ask_user_before_retry",
      reason: "side_effect_facts_incomplete",
    })
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

  test("classifies known instance reload lifecycle closes with parent provenance", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_instance_reload"),
      traceID: MessageID.make("msg_instance_reload"),
      sessionID: SessionID.make("ses_instance_reload"),
      messageID: MessageID.make("msg_instance_reload"),
      providerID: "openai",
      modelID: "gpt-5.5",
      createdAt: 10,
      monotonicStartMs: 100,
    })
    recorder.recordScopeClosed({
      at: 20,
      monotonicMs: 200,
      source: "session.run_state.finalizer",
      reason: "scope_finalizer",
      propagationPoint: "session.prompt.loop.onInterrupt",
      lifecycleActionID: "lifecycle:instance_reload:abc123",
      lifecycleKind: "instance_reload",
    })

    const summary = recorder.finalize({ completedAt: 21, monotonicMs: 210 })
    expect(summary.classification).toBe("local_instance_reload")
    expect(String(summary.summary_key)).toBe("local_instance_reload.lifecycle_close")
    expect(summary.lifecycle).toEqual({
      action_id: "lifecycle:instance_reload:abc123",
      kind: "instance_reload",
      source: "session.run_state.finalizer",
      reason: "scope_finalizer",
    })
    expect(summary.missing_provenance).toBeUndefined()
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

  test("keeps sanitized tool names in incident evidence", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_tool_name_evidence"),
      traceID: MessageID.make("msg_tool_name_evidence"),
      sessionID: SessionID.make("ses_tool_name_evidence"),
      messageID: MessageID.make("msg_tool_name_evidence"),
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
    recorder.recordToolFailed({ attemptID: attempt.attemptID, at: 13, monotonicMs: 130, error: new Error("failed") })

    const evidence = recorder.finalize({ completedAt: 14, monotonicMs: 140 }).incident?.evidence ?? []
    expect(String(evidence.find((event) => event.event_type === "tool_execution_started")?.tool_name)).toBe("read")
    expect(JSON.stringify(evidence)).not.toContain("/Users/alice")
    expect(JSON.stringify(evidence)).not.toContain("secret")
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
