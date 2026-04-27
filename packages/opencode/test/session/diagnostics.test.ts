import { describe, expect, test } from "bun:test"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import type { MessageV2 } from "../../src/session/message-v2"
import { SessionDiagnostics } from "../../src/session/diagnostics"
import { ModelID, ProviderID } from "../../src/provider/schema"

const sessionID = SessionID.make("ses_diagnostics")
const parentID = MessageID.make("msg_user")
const modelID = ModelID.make("test-model")
const providerID = ProviderID.make("test")

function loop(metadata: SessionDiagnostics.Metadata) {
  const value = metadata.diagnostics?.loop
  if (!value) throw new Error("expected loop diagnostics")
  return value
}

describe("SessionDiagnostics.normalizeInput", () => {
  test("keeps stable hashes for reordered keys and non-semantic request ids", () => {
    const a = SessionDiagnostics.normalizeInput({
      url: "https://example.com/article",
      requestId: "one",
      nested: { b: 2, a: 1 },
    })
    const b = SessionDiagnostics.normalizeInput({
      nested: { a: 1, b: 2 },
      requestId: "two",
      url: "https://example.com/article",
    })

    expect(a.hash).toBe(b.hash)
  })

  test("keeps cursor as semantic input", () => {
    const first = SessionDiagnostics.normalizeInput({ query: "Kimi K2.6", cursor: "page-1" })
    const second = SessionDiagnostics.normalizeInput({ query: "Kimi K2.6", cursor: "page-2" })

    expect(first.hash).not.toBe(second.hash)
  })
})

describe("SessionDiagnostics.observeToolCall", () => {
  test("creates one pending reminder on the third repeated input in one user block", () => {
    let records: SessionDiagnostics.ToolCallRecord[] = []
    const input = { url: "https://example.com/article" }

    for (let i = 0; i < 3; i++) {
      const observed = SessionDiagnostics.observeToolCall({
        records,
        sessionID,
        parentID,
        tool: "webfetch",
        input,
        agent: "build",
        modelID,
        providerID,
      })
      records = [...records, observed.record]
    }

    const third = loop(records[2]!.metadata)
    expect(third.inputRepeatCount).toBe(3)
    expect(third.reminders).toHaveLength(1)
    expect(third.reminders?.[0]).toMatchObject({
      type: "input_repeat",
      status: "pending",
      count: 3,
    })

    const fourth = SessionDiagnostics.observeToolCall({
      records,
      sessionID,
      parentID,
      tool: "webfetch",
      input,
      agent: "build",
      modelID,
      providerID,
    })

    expect(loop(fourth.record.metadata).inputRepeatCount).toBe(4)
    expect(loop(fourth.record.metadata).reminders ?? []).toHaveLength(0)
  })

  test("does not count the same input across different user blocks", () => {
    const input = { url: "https://example.com/article" }
    const records: SessionDiagnostics.ToolCallRecord[] = [
      SessionDiagnostics.observeToolCall({
        records: [],
        sessionID,
        parentID,
        tool: "webfetch",
        input,
        agent: "build",
        modelID,
        providerID,
      }).record,
      SessionDiagnostics.observeToolCall({
        records: [],
        sessionID,
        parentID: MessageID.make("msg_other_user"),
        tool: "webfetch",
        input,
        agent: "build",
        modelID,
        providerID,
      }).record,
    ]

    const observed = SessionDiagnostics.observeToolCall({
      records,
      sessionID,
      parentID,
      tool: "webfetch",
      input,
      agent: "build",
      modelID,
      providerID,
    })

    expect(loop(observed.record.metadata).inputRepeatCount).toBe(2)
    expect(loop(observed.record.metadata).reminders ?? []).toHaveLength(0)
  })

  test("does not create input reminders for different URLs in an exploratory block", () => {
    let records: SessionDiagnostics.ToolCallRecord[] = []

    for (let i = 0; i < 30; i++) {
      const observed = SessionDiagnostics.observeToolCall({
        records,
        sessionID,
        parentID,
        tool: "webfetch",
        input: { url: `https://example.com/article-${i}` },
        agent: "build",
        modelID,
        providerID,
      })
      records = [...records, observed.record]
    }

    expect(records.flatMap((record) => loop(record.metadata).reminders ?? [])).toHaveLength(0)
  })
})

describe("SessionDiagnostics.observeToolError", () => {
  test("normalizes equivalent error messages into one error reminder", () => {
    let records: SessionDiagnostics.ToolErrorRecord[] = []

    for (const error of [
      "GitHub inline review failed: position 12 is outside diff",
      "GitHub inline review failed: position 18 is outside diff",
      "GitHub inline review failed: position 44 is outside diff",
    ]) {
      const observed = SessionDiagnostics.observeToolError({
        records,
        sessionID,
        parentID,
        tool: "github",
        error,
      })
      records = [...records, observed.record]
    }

    const third = loop(records[2]!.metadata)
    expect(third.errorRepeatCount).toBe(3)
    expect(third.reminders?.[0]).toMatchObject({
      type: "error_repeat",
      status: "pending",
      count: 3,
    })
  })
})

describe("SessionDiagnostics metadata helpers", () => {
  test("merges diagnostics without losing existing tool metadata", () => {
    const merged = SessionDiagnostics.mergeMetadata(
      { truncated: false, outputPath: "/tmp/out" },
      { diagnostics: { loop: { inputHash: "abc", inputRepeatCount: 1 } } },
    )

    expect(merged).toEqual({
      truncated: false,
      outputPath: "/tmp/out",
      diagnostics: { loop: { inputHash: "abc", inputRepeatCount: 1 } },
    })
  })

  test("summarizes known targets without storing readable values", () => {
    const summary = SessionDiagnostics.targetSummary("webfetch", {
      url: "https://example.com/private?token=secret-token&query=visible",
    })
    const command = SessionDiagnostics.targetSummary("bash", {
      command: "curl -H 'Authorization: Bearer short-token' https://internal.example",
    })

    expect(summary).toMatch(/^url:[a-f0-9]{16}$/)
    expect(summary).not.toContain("example.com")
    expect(summary).not.toContain("private")
    expect(summary).not.toContain("secret-token")
    expect(summary).not.toContain("visible")
    expect(command).toMatch(/^command:[a-f0-9]{16}$/)
    expect(command).not.toContain("Bearer")
    expect(command).not.toContain("internal")
  })

  test("summarizes unknown inputs without storing readable payloads", () => {
    const summary = SessionDiagnostics.targetSummary("custom", {
      prompt: "sensitive internal request",
      token: "secret-token",
    })

    expect(summary).toMatch(/^custom:input:[a-f0-9]{16}$/)
    expect(summary).not.toContain("sensitive")
    expect(summary).not.toContain("secret-token")
  })
})

describe("SessionDiagnostics v1 schema", () => {
  test("LoopAction enum is observe|block|stop only", () => {
    const all: SessionDiagnostics.LoopAction[] = ["observe", "block", "stop"]
    expect(all).toHaveLength(3)
  })
})

describe("SessionDiagnostics.truncateForRenderer", () => {
  test("returns short strings unchanged", () => {
    expect(SessionDiagnostics.truncateForRenderer("hello")).toBe("hello")
  })
  test("serializes objects via JSON.stringify before truncation", () => {
    expect(SessionDiagnostics.truncateForRenderer({ url: "https://x.com" })).toBe('{"url":"https://x.com"}')
  })
  test("truncates long strings with ellipsis at codepoint boundary", () => {
    const out = SessionDiagnostics.truncateForRenderer("a".repeat(2000))
    expect(out.endsWith("…")).toBe(true)
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(1024 + 4)
  })
  test("does not split a percent-encoded sequence", () => {
    const head = "x".repeat(1022)
    const out = SessionDiagnostics.truncateForRenderer(head + "%2F" + "y".repeat(100))
    expect(out.endsWith("%")).toBe(false)
    expect(/%[0-9A-Fa-f]$/.test(out.replace(/…$/, ""))).toBe(false)
  })
  test("does not split a multibyte codepoint", () => {
    const out = SessionDiagnostics.truncateForRenderer("a".repeat(1023) + "中文")
    expect(() => Buffer.from(out, "utf8").toString("utf8")).not.toThrow()
  })
  test("survives circular structures via String fallback", () => {
    const o: Record<string, unknown> = { a: 1 }
    o.self = o
    expect(() => SessionDiagnostics.truncateForRenderer(o)).not.toThrow()
    expect(typeof SessionDiagnostics.truncateForRenderer(o)).toBe("string")
  })
  test("survives BigInt via String fallback", () => {
    expect(() => SessionDiagnostics.truncateForRenderer({ big: 10n })).not.toThrow()
    expect(typeof SessionDiagnostics.truncateForRenderer({ big: 10n })).toBe("string")
  })
})

describe("SessionDiagnostics.consumeReminders", () => {
  test("returns one model reminder and marks pending records injected", () => {
    const part: MessageV2.ToolPart = {
      id: PartID.make("prt_diag"),
      messageID: MessageID.make("msg_assistant"),
      sessionID,
      type: "tool",
      tool: "webfetch",
      callID: "call_diag",
      state: {
        status: "completed",
        input: { url: "https://example.com/article" },
        output: "ok",
        title: "ok",
        metadata: {
          diagnostics: {
            loop: {
              reminders: [
                {
                  key: "input:msg_user:webfetch:abc",
                  type: "input_repeat",
                  status: "pending",
                  count: 3,
                  createdAt: 1,
                },
              ],
            },
          },
        },
        time: { start: 1, end: 2 },
      },
    }
    const messages: MessageV2.WithParts[] = [
      {
        info: {
          id: MessageID.make("msg_assistant"),
          role: "assistant",
          sessionID,
          mode: "build",
          agent: "build",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID,
          providerID,
          parentID,
          time: { created: 1 },
        },
        parts: [part],
      },
    ]

    const result = SessionDiagnostics.consumeReminders({ messages, parentID, now: 10 })

    expect(result.text).toContain("repeated the same tool input 3 times")
    expect(result.parts).toHaveLength(1)
    const updated = result.parts[0]?.state
    expect(updated?.status).toBe("completed")
    if (updated?.status !== "completed") throw new Error("expected completed state")
    expect(updated.metadata.diagnostics.loop.reminders[0]).toMatchObject({
      status: "injected",
      injectedAt: 10,
    })

    const again = SessionDiagnostics.consumeReminders({
      messages: [{ ...messages[0]!, parts: result.parts }],
      parentID,
      now: 11,
    })
    expect(again.text).toBeUndefined()
    expect(again.parts).toHaveLength(0)
  })
})
