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
  test("does not create reminders on repeated calls (firing moved to observeToolError)", () => {
    let records: SessionDiagnostics.ToolCallRecord[] = []
    const input = { url: "https://example.com/article" }
    for (let i = 0; i < 5; i++) {
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
    for (const record of records) {
      expect(record.metadata.diagnostics?.loop?.reminders ?? []).toHaveLength(0)
    }
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
  test("normalizes equivalent error messages so same_input fires once across error variants", () => {
    const input = { url: "https://example.com/a" }
    const records: SessionDiagnostics.ToolErrorRecord[] = []
    for (const error of [
      new Error("Request failed: 504 (id 12345)"),
      new Error("Request failed: 504 (id 67890)"),
      new Error("Request failed: 504 (id abcdef)"),
    ]) {
      const observed = SessionDiagnostics.observeToolError({
        records,
        sessionID,
        parentID,
        tool: "webfetch",
        inputHash: SessionDiagnostics.normalizeInput(input).hash,
        targetHash: SessionDiagnostics.hash("url:" + SessionDiagnostics.hash("https://example.com/a")),
        originalInput: input,
        error,
      })
      records.push(observed.record)
    }
    const fired = records.flatMap((r) => r.metadata.diagnostics?.loop?.loopRecoverFiredFor ?? [])
    expect(fired.filter((k) => k.startsWith("input:"))).toHaveLength(1)
  })
})

const targetHashFor = (url: string) => SessionDiagnostics.hash("url:" + SessionDiagnostics.hash(url))
const inputHashFor = (input: unknown) => SessionDiagnostics.normalizeInput(input).hash

describe("SessionDiagnostics.observeToolError v1 firing", () => {
  test("fires recover for both same_input and same_target on the third failure", () => {
    const input = { url: "https://example.com/a" }
    const records: SessionDiagnostics.ToolErrorRecord[] = []
    for (let i = 0; i < 3; i++) {
      const observed = SessionDiagnostics.observeToolError({
        records,
        sessionID,
        parentID,
        tool: "webfetch",
        inputHash: inputHashFor(input),
        targetHash: targetHashFor("https://example.com/a"),
        originalInput: input,
        error: new Error("404"),
      })
      records.push(observed.record)
    }
    const fired = records.flatMap((r) => r.metadata.diagnostics?.loop?.loopRecoverFiredFor ?? [])
    expect(fired.filter((k) => k.startsWith("input:"))).toHaveLength(1)
    expect(fired.filter((k) => k.startsWith("target:"))).toHaveLength(1)
  })

  test("persists raw lastInput and string lastError on every record", () => {
    const input = { url: "https://example.com/a" }
    const observed = SessionDiagnostics.observeToolError({
      records: [],
      sessionID,
      parentID,
      tool: "webfetch",
      inputHash: inputHashFor(input),
      targetHash: targetHashFor("https://example.com/a"),
      originalInput: input,
      error: new Error("404 Not Found"),
    })
    expect(observed.record.lastInput).toEqual(input)
    expect(typeof observed.record.lastError).toBe("string")
    expect(observed.record.lastError as string).toContain("404")
  })

  test("does not fire same_target when targetHash absent", () => {
    const records: SessionDiagnostics.ToolErrorRecord[] = []
    for (let i = 0; i < 3; i++) {
      const observed = SessionDiagnostics.observeToolError({
        records,
        sessionID,
        parentID,
        tool: "mystery",
        inputHash: SessionDiagnostics.hash("x"),
        targetHash: undefined,
        originalInput: { foo: "bar" },
        error: new Error("boom"),
      })
      records.push(observed.record)
    }
    const fired = records.flatMap((r) => r.metadata.diagnostics?.loop?.loopRecoverFiredFor ?? [])
    expect(fired.some((k) => k.startsWith("target:"))).toBe(false)
    expect(fired.filter((k) => k.startsWith("input:"))).toHaveLength(1)
  })

  test("labels input vs target reminders correctly via Reminder.type", () => {
    const input = { url: "https://example.com/a" }
    const records: SessionDiagnostics.ToolErrorRecord[] = []
    for (let i = 0; i < 3; i++) {
      const observed = SessionDiagnostics.observeToolError({
        records,
        sessionID,
        parentID,
        tool: "webfetch",
        inputHash: inputHashFor(input),
        targetHash: targetHashFor("https://example.com/a"),
        originalInput: input,
        error: new Error("404"),
      })
      records.push(observed.record)
    }
    const allReminders = records.flatMap((r) => r.metadata.diagnostics?.loop?.reminders ?? [])
    const inputReminder = allReminders.find((r) => r.key.startsWith("input:"))
    const targetReminder = allReminders.find((r) => r.key.startsWith("target:"))
    expect(inputReminder?.type).toBe("input_repeat")
    expect(targetReminder?.type).toBe("target_repeat")
  })

  test("recomputes inputHash from originalInput when in-flight metadata missing", () => {
    const original = { url: "https://example.com/a" }
    const records: SessionDiagnostics.ToolErrorRecord[] = []
    for (let i = 0; i < 3; i++) {
      const observed = SessionDiagnostics.observeToolError({
        records,
        sessionID,
        parentID,
        tool: "webfetch",
        inputHash: undefined,
        targetHash: undefined,
        originalInput: original,
        error: new Error("404"),
      })
      records.push(observed.record)
    }
    const fired = records.flatMap((r) => r.metadata.diagnostics?.loop?.loopRecoverFiredFor ?? [])
    expect(fired.filter((k) => k.startsWith("input:"))).toHaveLength(1)
  })

  test("recomputes targetHash from originalInput when in-flight metadata missing", () => {
    // Both hashes missing → recovery path. originalInput has a recognized url field, so
    // target tracking must NOT silently degrade to input-only on the recovery path.
    const original = { url: "https://example.com/a", q: "x" }
    const records: SessionDiagnostics.ToolErrorRecord[] = []
    for (let i = 0; i < 3; i++) {
      // Vary a non-target field so input hashes differ but target stays stable; this is the
      // exact scenario that's silently broken when targetHash recovery is missing.
      const varied = { ...original, q: `q-${i}` }
      const observed = SessionDiagnostics.observeToolError({
        records,
        sessionID,
        parentID,
        tool: "webfetch",
        inputHash: undefined,
        targetHash: undefined,
        originalInput: varied,
        error: new Error("404"),
      })
      records.push(observed.record)
    }
    const fired = records.flatMap((r) => r.metadata.diagnostics?.loop?.loopRecoverFiredFor ?? [])
    expect(fired.filter((k) => k.startsWith("target:"))).toHaveLength(1)
    // And the persisted record carries the recovered targetHash for future iterations.
    const last = records[records.length - 1]
    expect(typeof last?.targetHash).toBe("string")
    expect(last?.targetHash).not.toBe("")
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
    }).summary
    const command = SessionDiagnostics.targetSummary("bash", {
      command: "curl -H 'Authorization: Bearer <token>' https://internal.example",
    }).summary

    expect(summary).toMatch(/^url:[a-f0-9]{16}$/)
    expect(summary).not.toContain("example.com")
    expect(summary).not.toContain("private")
    expect(summary).not.toContain("secret-token")
    expect(summary).not.toContain("visible")
    expect(command).toMatch(/^command:[a-f0-9]{16}$/)
    expect(command).not.toContain("Bearer")
    expect(command).not.toContain("internal")
  })

  test("normalizes filePath / filepath into the same path hash across file tools (target accumulation is still tool-scoped)", () => {
    const a = SessionDiagnostics.targetSummary("read", { filePath: "/tmp/a.txt" })
    const b = SessionDiagnostics.targetSummary("edit", { filePath: "/tmp/a.txt", oldString: "x", newString: "y" })
    const c = SessionDiagnostics.targetSummary("write", { filepath: "/tmp/a.txt", content: "..." })
    expect(a.isFallback).toBe(false)
    expect(b.isFallback).toBe(false)
    expect(c.isFallback).toBe(false)
    expect(a.summary).toMatch(/^path:[a-f0-9]{16}$/)
    expect(a.summary).toBe(b.summary)
    expect(a.summary).toBe(c.summary)
  })

  test("summarizes unknown inputs without storing readable payloads", () => {
    const summary = SessionDiagnostics.targetSummary("custom", {
      prompt: "sensitive internal request",
      token: "secret-token",
    }).summary

    expect(summary).toMatch(/^custom:input:[a-f0-9]{16}$/)
    expect(summary).not.toContain("sensitive")
    expect(summary).not.toContain("secret-token")
  })

  test("blank/whitespace target fields fall back instead of poisoning a stable hash", () => {
    // Empty string and whitespace-only would otherwise hash to a stable "url:..." token and
    // make malformed inputs accumulate as same_target. Should be treated as "no target" and
    // fall through to the generic input fallback.
    const blankUrl = SessionDiagnostics.targetSummary("webfetch", { url: "" })
    const wsPath = SessionDiagnostics.targetSummary("read", { filePath: "   " })
    expect(blankUrl.isFallback).toBe(true)
    expect(wsPath.isFallback).toBe(true)
    expect(blankUrl.summary).not.toMatch(/^url:/)
    expect(wsPath.summary).not.toMatch(/^path:/)
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

describe("SessionDiagnostics targetRepeatCount cross-tool semantics", () => {
  test("cross-tool same target keeps newTarget=true (exploration, not loop)", () => {
    const url = "https://example.com/a"
    const first = SessionDiagnostics.observeToolCall({
      records: [],
      sessionID,
      parentID,
      tool: "webfetch",
      input: { url },
      agent: "build",
      modelID,
      providerID,
    })
    const second = SessionDiagnostics.observeToolCall({
      records: [first.record],
      sessionID,
      parentID,
      tool: "fetch",
      input: { url },
      agent: "build",
      modelID,
      providerID,
    })
    expect(second.record.metadata.diagnostics?.loop?.newTarget).toBe(true)
    expect(second.record.metadata.diagnostics?.loop?.targetRepeatCount).toBe(1)
  })

  test("same-tool same-target accumulates targetRepeatCount", () => {
    const url = "https://example.com/a"
    const first = SessionDiagnostics.observeToolCall({
      records: [],
      sessionID,
      parentID,
      tool: "webfetch",
      input: { url },
      agent: "build",
      modelID,
      providerID,
    })
    const second = SessionDiagnostics.observeToolCall({
      records: [first.record],
      sessionID,
      parentID,
      tool: "webfetch",
      input: { url },
      agent: "build",
      modelID,
      providerID,
    })
    expect(second.record.metadata.diagnostics?.loop?.targetRepeatCount).toBe(2)
    expect(second.record.metadata.diagnostics?.loop?.newTarget).toBe(false)
  })
})

describe("SessionDiagnostics targetHashIsFallback", () => {
  test("is false on webfetch with a recognized URL", () => {
    const observed = SessionDiagnostics.observeToolCall({
      records: [],
      sessionID,
      parentID,
      tool: "webfetch",
      input: { url: "https://example.com/a" },
      agent: "build",
      modelID,
      providerID,
    })
    expect(observed.record.metadata.diagnostics?.loop?.targetHashIsFallback).toBe(false)
  })
  test("is true on a tool whose input has no findTarget hit", () => {
    const observed = SessionDiagnostics.observeToolCall({
      records: [],
      sessionID,
      parentID,
      tool: "mystery",
      input: { foo: "bar" },
      agent: "build",
      modelID,
      providerID,
    })
    expect(observed.record.metadata.diagnostics?.loop?.targetHashIsFallback).toBe(true)
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

  test("emits legacy copy as fallback for v0 error: prefix reminders", () => {
    const part: MessageV2.ToolPart = {
      id: PartID.make("prt_legacy"),
      messageID: MessageID.make("msg_assistant_legacy"),
      sessionID,
      type: "tool",
      tool: "github",
      callID: "call_legacy",
      state: {
        status: "error",
        input: { x: 1 },
        error: "504",
        metadata: {
          diagnostics: {
            loop: {
              reminders: [
                {
                  key: "error:msg_user:github:abc",
                  type: "error_repeat",
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
          id: MessageID.make("msg_assistant_legacy"),
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
    expect(result.text).toContain("class of tool error")
  })

  test("target reminder text describes same-target failures, not same-error class", () => {
    const part: MessageV2.ToolPart = {
      id: PartID.make("prt_target"),
      messageID: MessageID.make("msg_assistant_t"),
      sessionID,
      type: "tool",
      tool: "webfetch",
      callID: "call_t",
      state: {
        status: "error",
        input: { url: "https://example.com/a" },
        error: "404",
        metadata: {
          diagnostics: {
            loop: {
              reminders: [
                {
                  key: "target:webfetch:abc",
                  type: "target_repeat",
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
          id: MessageID.make("msg_assistant_t"),
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
    expect(result.text).toContain("failed against the same target")
    expect(result.text).not.toContain("class of tool error")
  })
})
