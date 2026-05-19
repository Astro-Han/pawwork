import { describe, expect, test } from "bun:test"
import { LLMTrace } from "../../src/session/llm-trace"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import type { MessageV2 } from "../../src/session/message-v2"

describe("LLMTrace", () => {
  test("keeps request summaries to a safe allowlist", () => {
    const summary = LLMTrace.requestSummary({
      streaming: true,
      toolCount: 2,
      toolChoice: "auto",
      small: false,
      reasoningCapability: true,
      interleavedField: "reasoning_content",
      options: {
        temperature: 0.2,
        topP: 0.9,
        topK: 40,
        maxOutputTokens: 8192,
        apiKey: "secret",
        headers: { authorization: "Bearer secret" },
        messages: [{ role: "user", content: "private prompt" }],
      },
    })

    expect(summary).toEqual({
      streaming: true,
      tool_count: 2,
      tool_choice: "auto",
      small: false,
      reasoning_capability: true,
      interleaved_field: "reasoning_content",
      options: {
        temperature: 0.2,
        top_p: 0.9,
        top_k: 40,
        max_output_tokens: 8192,
      },
    })
    expect(JSON.stringify(summary)).not.toContain("secret")
    expect(JSON.stringify(summary)).not.toContain("private prompt")
  })

  test("counts normalized stream event types without retaining payload text", () => {
    const recorder = LLMTrace.createRecorder({
      traceID: MessageID.make("msg_trace"),
      sessionID: SessionID.make("ses_trace"),
      messageID: MessageID.make("msg_trace"),
      parentMessageID: MessageID.make("msg_parent"),
      providerID: "test",
      modelID: "model",
      agent: "build",
      createdAt: 1,
    })

    recorder.observeEvent({ type: "text-delta", text: "private output" })
    recorder.observeEvent({ type: "reasoning-delta", text: "private thought" })
    recorder.observeEvent({ type: "tool-call", toolName: "bash" })
    recorder.observeEvent({ type: "error", error: new Error("private response body") })

    const summary = recorder.finalize({
      completedAt: 2,
      storedParts: [],
      tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 0, write: 0 } },
      finishReason: "stop",
    })

    expect(summary.stream_events).toMatchObject({
      text_delta: 1,
      reasoning_delta: 1,
      tool_call: 1,
      error: 1,
      finish_reason: "stop",
    })
    expect(summary.tokens).toEqual({ input: 1, output: 2, reasoning: 3, cache_read: 0, cache_write: 0 })
    expect(JSON.stringify(summary)).not.toContain("private output")
    expect(JSON.stringify(summary)).not.toContain("private thought")
    expect(JSON.stringify(summary)).not.toContain("private response body")
  })

  test("counts final stored part types and flags empty completions", () => {
    const recorder = LLMTrace.createRecorder({
      traceID: MessageID.make("msg_trace"),
      sessionID: SessionID.make("ses_trace"),
      messageID: MessageID.make("msg_trace"),
      providerID: "test",
      modelID: "model",
      agent: "build",
      createdAt: 1,
    })

    const text: MessageV2.TextPart = {
      id: PartID.make("prt_text"),
      sessionID: SessionID.make("ses_trace"),
      messageID: MessageID.make("msg_trace"),
      type: "text",
      text: "hello",
    }
    const reasoning: MessageV2.ReasoningPart = {
      id: PartID.make("prt_reasoning"),
      sessionID: SessionID.make("ses_trace"),
      messageID: MessageID.make("msg_trace"),
      type: "reasoning",
      text: "think",
      time: { start: 1, end: 2 },
    }

    const withParts = recorder.finalize({ completedAt: 2, finishReason: "stop", storedParts: [text, reasoning] })
    expect(withParts.stored_parts).toMatchObject({ text: 1, reasoning: 1 })
    expect(withParts.flags.empty_completion).toBe(false)

    const empty = recorder.finalize({ completedAt: 3, finishReason: "stop", storedParts: [] })
    expect(empty.flags.empty_completion).toBe(true)
  })

  test("classifies overlapping watchdog abort evidence without treating signal state as local abort", () => {
    expect(
      LLMTrace.classifyBoundary({
        watchdogFired: true,
        watchdogError: true,
        abortSignalAborted: true,
        iteratorError: true,
      }),
    ).toEqual({
      boundary: "watchdog",
      confidence: "high",
      evidence: ["watchdog_fired", "watchdog_error", "abort_signal_aborted", "iterator_error"],
    })

    expect(
      LLMTrace.classifyBoundary({
        abortSignalAborted: true,
        abortProvenancePresent: false,
        iteratorError: true,
      }),
    ).toEqual({
      boundary: "unknown",
      confidence: "low",
      evidence: ["abort_signal_aborted", "abort_provenance_missing", "iterator_error"],
    })
  })

  test("records safe error fingerprints before persistence", () => {
    const recorder = LLMTrace.createRecorder({
      traceID: MessageID.make("msg_trace"),
      sessionID: SessionID.make("ses_trace"),
      messageID: MessageID.make("msg_trace"),
      providerID: "test",
      modelID: "model",
      agent: "build",
      createdAt: 1,
    })

    recorder.beginStream({
      collectorCreatedAt: 10,
      monotonicMs: 100,
      connectTimeoutMs: 30_000,
      streamTimeoutMs: 600_000,
    })
    recorder.recordStreamFailure({
      error: {
        name: "ProviderError",
        message:
          "request failed for https://secret.example.invalid/body with token sk-private and paths /Users/alice/project/file.ts /home/bob/project/file.ts",
        code: "terminated",
        cause: { name: "CauseError", message: "Authorization: Bearer secret" },
        stack: "ProviderError: boom\n    at /Users/alice/project/file.ts:1:1",
      },
      boundary: "sdk_transport",
      confidence: "low",
      evidence: ["iterator_error", "provider_progress_seen"],
      failedAt: 20,
      monotonicMs: 150,
    })

    const summary = recorder.finalize({ completedAt: 21, storedParts: [] })
    const serialized = JSON.stringify(summary)
    expect(summary.stream?.error).toMatchObject({
      name: "ProviderError",
      message: expect.stringContaining("[redacted:url]"),
      code: "terminated",
      cause_name: "CauseError",
      cause_message: expect.stringContaining("[redacted:secret]"),
      boundary: "sdk_transport",
      confidence: "low",
    })
    expect(serialized).not.toContain("secret.example.invalid")
    expect(serialized).not.toContain("sk-private")
    expect(serialized).not.toContain("/Users/alice")
    expect(serialized).not.toContain("/home/bob")
    expect(serialized).not.toContain("Bearer secret")
  })

  test("extracts provider correlation only from reviewed safe keys", () => {
    const correlation = LLMTrace.safeProviderCorrelation({
      request_id: "req_123",
      responseId: "resp_456",
      status_code: 529,
      headers: {
        "x-request-id": "req_header",
        authorization: "Bearer secret",
        cookie: "session=secret",
        "x-provider-body": "raw private body",
        "x-trace-id": "trace_789",
      },
      url: "https://secret.example.invalid/path?token=secret",
      body: "private response body",
    })

    expect(correlation).toEqual({
      request_id: "req_123",
      response_id: "resp_456",
      status_code: 529,
      safe_headers: {
        "x-request-id": "req_header",
        "x-trace-id": "trace_789",
      },
    })
    expect(JSON.stringify(correlation)).not.toContain("Bearer")
    expect(JSON.stringify(correlation)).not.toContain("private response body")
    expect(JSON.stringify(correlation)).not.toContain("secret.example.invalid")
  })

  test("records explicit provider error events as safe provider stream failures", () => {
    const recorder = LLMTrace.createRecorder({
      traceID: MessageID.make("msg_provider_error_trace"),
      sessionID: SessionID.make("ses_provider_error_trace"),
      messageID: MessageID.make("msg_provider_error_trace"),
      providerID: "test",
      modelID: "model",
      agent: "build",
      createdAt: 1,
    })

    recorder.beginStream({
      collectorCreatedAt: 10,
      monotonicMs: 100,
      connectTimeoutMs: 30_000,
      streamTimeoutMs: 600_000,
    })
    recorder.recordProviderErrorEvent({
      error: { name: "ProviderError", message: "raw body https://secret.example.invalid sk-private" },
      provider: { request_id: "req_provider", body: "private response body" },
      failedAt: 20,
      monotonicMs: 130,
    })

    const summary = recorder.finalize({ completedAt: 21, storedParts: [], streamError: true })
    expect(summary.stream?.error).toMatchObject({
      boundary: "provider_stream",
      confidence: "high",
      evidence: expect.arrayContaining(["provider_error_event", "request_id_present"]),
      name: "ProviderError",
    })
    expect(summary.stream?.provider?.request_id).toBe("req_provider")
    const serialized = JSON.stringify(summary)
    expect(serialized).not.toContain("secret.example.invalid")
    expect(serialized).not.toContain("sk-private")
    expect(serialized).not.toContain("private response body")
  })

  test("keeps high-confidence watchdog diagnostics when a provider error follows", () => {
    const recorder = LLMTrace.createRecorder({
      traceID: MessageID.make("msg_watchdog_provider_overlap"),
      sessionID: SessionID.make("ses_watchdog_provider_overlap"),
      messageID: MessageID.make("msg_watchdog_provider_overlap"),
      providerID: "test",
      modelID: "model",
      agent: "build",
      createdAt: 1,
    })

    recorder.beginStream({
      collectorCreatedAt: 10,
      monotonicMs: 100,
      connectTimeoutMs: 30_000,
      streamTimeoutMs: 600_000,
    })
    recorder.recordStreamFailure({
      error: new Error("LLM stream connection timed out after 30000ms"),
      boundary: "watchdog",
      confidence: "high",
      evidence: ["watchdog_fired", "watchdog_error"],
      failedAt: 20,
      monotonicMs: 130,
    })
    recorder.recordProviderErrorEvent({
      error: { name: "ProviderError", message: "late provider error" },
      provider: { request_id: "req_late" },
      failedAt: 21,
      monotonicMs: 140,
    })

    const summary = recorder.finalize({ completedAt: 22, storedParts: [], streamError: true })
    expect(summary.stream?.error).toMatchObject({
      boundary: "watchdog",
      confidence: "high",
      evidence: ["watchdog_fired", "watchdog_error"],
    })
    expect(summary.stream?.provider).toBeUndefined()
  })

  test("keeps monotonic durations non-negative when sampled clocks move backward", () => {
    const recorder = LLMTrace.createRecorder({
      traceID: MessageID.make("msg_duration_trace"),
      sessionID: SessionID.make("ses_duration_trace"),
      messageID: MessageID.make("msg_duration_trace"),
      providerID: "test",
      modelID: "model",
      agent: "build",
      createdAt: 1,
    })

    recorder.beginStream({
      collectorCreatedAt: 10,
      monotonicMs: 100,
      connectTimeoutMs: 30_000,
      streamTimeoutMs: 600_000,
    })
    recorder.recordStreamFailure({
      error: new Error("terminated"),
      boundary: "sdk_transport",
      confidence: "low",
      evidence: ["iterator_error"],
      failedAt: 20,
      monotonicMs: 90,
    })

    const summary = recorder.finalize({ completedAt: 21, storedParts: [], streamError: true })
    expect(summary.stream?.timeline.durations_ms?.total).toBe(0)
  })

  test("labels legacy v1 counters as aggregate when stream diagnostics track the terminal attempt", () => {
    const recorder = LLMTrace.createRecorder({
      traceID: MessageID.make("msg_retry_trace"),
      sessionID: SessionID.make("ses_retry_trace"),
      messageID: MessageID.make("msg_retry_trace"),
      providerID: "test",
      modelID: "model",
      agent: "build",
      createdAt: 1,
    })

    recorder.beginStream({
      collectorCreatedAt: 10,
      monotonicMs: 100,
      connectTimeoutMs: 30_000,
      streamTimeoutMs: 600_000,
    })
    recorder.observeEvent({ type: "text-delta", text: "first attempt progress" })
    recorder.beginStream({
      collectorCreatedAt: 20,
      monotonicMs: 200,
      connectTimeoutMs: 30_000,
      streamTimeoutMs: 600_000,
    })
    recorder.recordStreamFailure({
      error: new Error("terminated"),
      boundary: "sdk_transport",
      confidence: "low",
      evidence: ["iterator_error"],
      failedAt: 30,
      monotonicMs: 230,
    })

    const summary = recorder.finalize({ completedAt: 31, storedParts: [], streamError: true })
    expect(summary.stream_events.text_delta).toBe(1)
    expect(summary.stream?.legacy_v1_counters).toBe("aggregate")
    expect(summary.stream?.timeline.collector_created_at).toBe(20)
  })

  test("classifies local abort as high confidence when abort provenance is present", () => {
    const recorder = LLMTrace.createRecorder({
      traceID: MessageID.make("msg_local_abort_trace"),
      sessionID: SessionID.make("ses_local_abort_trace"),
      messageID: MessageID.make("msg_local_abort_trace"),
      providerID: "test",
      modelID: "model",
      agent: "build",
      createdAt: 1,
    })

    recorder.beginStream({
      collectorCreatedAt: 10,
      monotonicMs: 100,
      connectTimeoutMs: 30_000,
      streamTimeoutMs: 600_000,
    })
    recorder.recordAbortState({
      signalAbortedAtError: true,
      provenanceSource: "session.processor.onInterrupt",
      provenanceReason: "aborted",
      provenanceMode: "hard",
      provenanceRecordedAt: 20,
    })
    recorder.recordStreamFailure({
      error: new DOMException("Aborted", "AbortError"),
      boundary: "unknown",
      confidence: "low",
      evidence: ["abort_signal_aborted", "abort_provenance_missing", "iterator_error"],
      failedAt: 21,
      monotonicMs: 130,
    })

    const summary = recorder.finalize({ completedAt: 22, storedParts: [], streamError: true, aborted: true })
    expect(summary.stream?.abort).toMatchObject({
      signal_aborted_at_error: true,
      provenance_source: "session.processor.onInterrupt",
      provenance_reason: "aborted",
      provenance_mode: "hard",
      provenance_recorded_at: 20,
    })
    expect(summary.stream?.error).toMatchObject({
      boundary: "local_abort",
      confidence: "high",
      evidence: expect.arrayContaining(["abort_signal_aborted", "abort_provenance_present", "iterator_error"]),
    })
  })

  test("keeps watchdog boundary when local abort provenance overlaps watchdog failure", () => {
    const recorder = LLMTrace.createRecorder({
      traceID: MessageID.make("msg_watchdog_abort_overlap"),
      sessionID: SessionID.make("ses_watchdog_abort_overlap"),
      messageID: MessageID.make("msg_watchdog_abort_overlap"),
      providerID: "test",
      modelID: "model",
      agent: "build",
      createdAt: 1,
    })

    recorder.beginStream({
      collectorCreatedAt: 10,
      monotonicMs: 100,
      connectTimeoutMs: 30_000,
      streamTimeoutMs: 600_000,
    })
    recorder.recordStreamFailure({
      error: new Error("LLM stream connection timed out after 30000ms"),
      boundary: "watchdog",
      confidence: "high",
      evidence: ["watchdog_fired", "watchdog_error"],
      failedAt: 20,
      monotonicMs: 130,
    })
    recorder.recordAbortState({
      signalAbortedAtError: true,
      provenanceSource: "session.processor.onInterrupt",
      provenanceReason: "aborted",
      provenanceMode: "hard",
      provenanceRecordedAt: 21,
    })

    const summary = recorder.finalize({ completedAt: 22, storedParts: [], streamError: true, aborted: true })
    expect(summary.stream?.error).toMatchObject({
      boundary: "watchdog",
      confidence: "high",
      evidence: ["watchdog_fired", "watchdog_error"],
    })
    expect(summary.stream?.abort?.provenance_source).toBe("session.processor.onInterrupt")
  })

  test("keeps aborted iterator failures unknown without abort provenance", () => {
    const recorder = LLMTrace.createRecorder({
      traceID: MessageID.make("msg_abort_missing_provenance"),
      sessionID: SessionID.make("ses_abort_missing_provenance"),
      messageID: MessageID.make("msg_abort_missing_provenance"),
      providerID: "test",
      modelID: "model",
      agent: "build",
      createdAt: 1,
    })

    recorder.beginStream({
      collectorCreatedAt: 10,
      monotonicMs: 100,
      connectTimeoutMs: 30_000,
      streamTimeoutMs: 600_000,
    })
    recorder.recordAbortState({ signalAbortedAtError: true, provenanceMissing: true })
    recorder.recordStreamFailure({
      error: new DOMException("Aborted", "AbortError"),
      boundary: "unknown",
      confidence: "low",
      evidence: ["abort_signal_aborted", "abort_provenance_missing", "iterator_error"],
      failedAt: 20,
      monotonicMs: 130,
    })

    const summary = recorder.finalize({ completedAt: 21, storedParts: [], streamError: true, aborted: true })
    expect(summary.stream?.abort).toMatchObject({
      signal_aborted_at_error: true,
      provenance_missing: true,
    })
    expect(summary.stream?.error).toMatchObject({
      boundary: "unknown",
      confidence: "low",
      evidence: ["abort_signal_aborted", "abort_provenance_missing", "iterator_error"],
    })
  })
})
