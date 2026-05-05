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
})
