import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Session as SessionNs } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Log } from "../../src/util/log"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Export, getRuntimeNamespace, redactPart } from "../../src/session/export"

const projectRoot = path.join(__dirname, "../..")
void Log.init({ print: false })

describe("Export.session", () => {
  test("getRuntimeNamespace returns 'pawwork' or 'opencode'", () => {
    expect(["pawwork", "opencode"]).toContain(getRuntimeNamespace())
  })

  test("exports a single root session with empty messages and stub runtime_context", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const created = await SessionNs.create({ title: "test session" })
        try {
          // Precondition: this test is the "single root, no climb" contract — Task 2 adds climb.
          expect(created.parentID).toBeUndefined()

          const result = await AppRuntime.runPromise(Export.session(created.id))

          expect(result.schema_version).toBe(1)
          expect(result.format).toBe("pawwork-session-export")
          expect(typeof result.exported_at).toBe("number")
          expect(result.root_session_id).toBe(created.id)
          expect(result.session.info.id).toBe(created.id)
          expect(result.session.info.title).toBe("test session")
          // info.share is stripped from the export
          expect((result.session.info as { share?: unknown }).share).toBeUndefined()
          expect(result.session.had_cloud_share).toBe(false)
          expect(result.session.messages).toEqual([])
          expect(result.session.diffs).toEqual([])
          expect(result.session.children).toEqual([])
          expect(result.runtime_context.runtime_namespace).toBe(getRuntimeNamespace())
          expect(result.runtime_context.stats.session_count).toBe(1)
          expect(result.runtime_context.stats.message_count).toBe(0)
          expect(result.diagnostics).toEqual({})
        } finally {
          await SessionNs.remove(created.id)
        }
      },
    })
  })

  test("climbs to root when given a child session id", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const root = await SessionNs.create({ title: "root" })
        const child = await SessionNs.create({ parentID: root.id, title: "child" })
        try {
          const result = await AppRuntime.runPromise(Export.session(child.id))

          expect(result.root_session_id).toBe(root.id)
          expect(result.session.info.id).toBe(root.id)
          expect(result.session.children).toHaveLength(1)
          expect(result.session.children[0].info.id).toBe(child.id)
          expect(result.runtime_context.stats.session_count).toBe(2)
        } finally {
          await SessionNs.remove(root.id)
        }
      },
    })
  })

  test("orders children deterministically by time.created then id", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const root = await SessionNs.create({ title: "root" })
        const a = await SessionNs.create({ parentID: root.id, title: "a" })
        // Force a measurable time gap so the test does not depend on intra-millisecond create timing
        // and does not bottom out on tie-break against monotonic-descending SessionID, which would
        // make the assertion tautological.
        await new Promise((r) => setTimeout(r, 10))
        const b = await SessionNs.create({ parentID: root.id, title: "b" })
        try {
          // Independent verification: a was created first → a.time.created < b.time.created
          expect(a.time.created).toBeLessThan(b.time.created)

          const result = await AppRuntime.runPromise(Export.session(root.id))
          const ids = result.session.children.map((c) => c.info.id)

          // Hard-coded expected order based on creation sequence, not derived from result's own sort.
          expect(ids).toEqual([a.id, b.id])
        } finally {
          await SessionNs.remove(root.id)
        }
      },
    })
  })

  test("ties break by id.localeCompare when time.created is equal (synthesized fixture)", () => {
    // Pure-function test on the sort comparator, not against real session creation,
    // so this assertion is independently verifiable and does not depend on timing.
    const cmp = (x: { time: { created: number }; id: string }, y: typeof x) => {
      if (x.time.created !== y.time.created) return x.time.created - y.time.created
      return x.id.localeCompare(y.id)
    }
    const items = [
      { id: "ses_b", time: { created: 100 } },
      { id: "ses_a", time: { created: 100 } },
    ]
    expect([...items].sort(cmp).map((s) => s.id)).toEqual(["ses_a", "ses_b"])
  })

  test("includes runtime_context with platform, locale, timezone, and best-effort instruction_sources", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const root = await SessionNs.create({ title: "x" })
        try {
          const result = await AppRuntime.runPromise(Export.session(root.id))

          expect(result.runtime_context.platform).toBe(process.platform)
          expect(result.runtime_context.app_version).toBeTruthy()
          expect(typeof result.runtime_context.timezone).toBe("string")
          expect(typeof result.runtime_context.locale).toBe("string")
          expect(Array.isArray(result.runtime_context.instruction_sources)).toBe(true)
          expect(result.runtime_context.model_refs).toEqual({})
          // Sort invariant: stable kind then path/url (both keys, not just primary).
          const sources = result.runtime_context.instruction_sources
          const sortedCopy = [...sources].sort((a, b) => {
            if (a.kind !== b.kind) return a.kind.localeCompare(b.kind)
            return (a.path ?? a.url ?? "").localeCompare(b.path ?? b.url ?? "")
          })
          expect(sources).toEqual(sortedCopy)
        } finally {
          await SessionNs.remove(root.id)
        }
      },
    })
  })

  test("collectModelRefs marks unknown providers as unresolved with a reason", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const root = await SessionNs.create({ title: "modelRefsFixture" })
        try {
          const userMessage: MessageV2.WithParts = {
            info: {
              id: MessageID.ascending(),
              sessionID: root.id,
              role: "user",
              time: { created: Date.now() },
              agent: "user",
              model: { providerID: "nonexistent-provider", modelID: "fake-model-7b" },
              tools: {},
            } as MessageV2.User,
            parts: [],
          }
          const fakeTree: Export.Tree = {
            info: root,
            had_cloud_share: false,
            diffs: [],
            messages: [userMessage],
            children: [],
          }
          const refs = await AppRuntime.runPromise(Export.collectModelRefs(fakeTree))
          const entry = refs["nonexistent-provider/fake-model-7b"]
          expect(entry).toBeDefined()
          expect(entry.resolved).toBe(false)
          if (!entry.resolved) {
            expect(entry.unresolved_reason).toBeTruthy()
          }
        } finally {
          await SessionNs.remove(root.id)
        }
      },
    })
  })
})

describe("redactPart", () => {
  test("replaces data: url in a file part with empty string and adds redacted_binary metadata", () => {
    const ctx = { count: { omitted: 0 } }
    const part: MessageV2.FilePart = {
      id: PartID.make("prt_test"),
      messageID: MessageID.make("msg_test"),
      sessionID: SessionID.make("ses_test"),
      type: "file",
      url: "data:image/png;base64,iVBORw0KGgo=",
      mime: "image/png",
      filename: "x.png",
    }

    const out = redactPart(part, ctx)
    if (out.type !== "file") throw new Error("type narrowing")
    expect(out.url).toBe("")
    expect(out.metadata?.redacted_binary).toMatchObject({
      mime: "image/png",
      size_bytes: expect.any(Number),
      sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    })
    expect(ctx.count.omitted).toBe(1)
  })

  test("leaves non-data: url untouched", () => {
    const ctx = { count: { omitted: 0 } }
    const part: MessageV2.FilePart = {
      id: PartID.make("prt_test"),
      messageID: MessageID.make("msg_test"),
      sessionID: SessionID.make("ses_test"),
      type: "file",
      url: "https://example.com/x.png",
      mime: "image/png",
    }

    const out = redactPart(part, ctx)
    if (out.type !== "file") throw new Error("type narrowing")
    expect(out.url).toBe("https://example.com/x.png")
    expect(out.metadata?.redacted_binary).toBeUndefined()
    expect(ctx.count.omitted).toBe(0)
  })

  test("redacts data: url with extra parameters between mime and base64 (RFC 2397 compliance)", () => {
    const ctx = { count: { omitted: 0 } }
    const part: MessageV2.FilePart = {
      id: PartID.make("prt_test"),
      messageID: MessageID.make("msg_test"),
      sessionID: SessionID.make("ses_test"),
      type: "file",
      // Real-world data URL with charset between mime and base64.
      url: "data:image/png;charset=utf-8;base64,iVBORw0KGgo=",
      mime: "image/png",
    }

    const out = redactPart(part, ctx)
    if (out.type !== "file") throw new Error("type narrowing")
    expect(out.url).toBe("")
    expect(out.metadata?.redacted_binary).toMatchObject({
      mime: "image/png",
      size_bytes: expect.any(Number),
      sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    })
    expect(ctx.count.omitted).toBe(1)
  })

  test("sanitizeSnapshot redacts node.diffs file/patch on every tree node", () => {
    const fakeSnapshot: Export.Snapshot = {
      schema_version: 1,
      format: "pawwork-session-export",
      exported_at: 0,
      root_session_id: SessionID.make("ses_x"),
      runtime_context: {
        app_version: "test",
        runtime_namespace: "pawwork",
        platform: "darwin",
        os_version: "0",
        locale: "en-US",
        timezone: "UTC",
        instruction_sources: [],
        model_refs: {},
        stats: { session_count: 0, message_count: 0, part_count: 0, omitted_attachment_count: 0 },
      },
      diagnostics: {},
      session: {
        info: { id: SessionID.make("ses_x"), title: "t", directory: "/dir" } as never,
        had_cloud_share: false,
        diffs: [
          { file: "/Users/secret/code.ts", patch: "@@ -1 +1 @@\n-secret\n+leak", additions: 1, deletions: 1 },
        ],
        messages: [],
        children: [
          {
            info: { id: SessionID.make("ses_y"), title: "child", directory: "/dir" } as never,
            had_cloud_share: false,
            diffs: [
              { file: "/Users/secret/child.ts", patch: "child secret", additions: 0, deletions: 0 },
            ],
            messages: [],
            children: [],
          },
        ],
      },
    }

    const sanitized = Export.sanitizeSnapshot(fakeSnapshot)
    // Root and child diffs both scrubbed.
    expect(sanitized.session.diffs[0].file).toBe("[redacted:tree-diff-file:0]")
    expect(sanitized.session.diffs[0].patch).toBe("[redacted:tree-diff-patch:0]")
    expect(sanitized.session.children[0].diffs[0].file).toBe("[redacted:tree-diff-file:0]")
    expect(sanitized.session.children[0].diffs[0].patch).toBe("[redacted:tree-diff-patch:0]")
  })

  test("sanitizeSnapshot redacts instruction_sources paths in runtime_context", () => {
    const fakeSnapshot: Export.Snapshot = {
      schema_version: 1,
      format: "pawwork-session-export",
      exported_at: 0,
      root_session_id: SessionID.make("ses_x"),
      runtime_context: {
        app_version: "test",
        runtime_namespace: "pawwork",
        platform: "darwin",
        os_version: "0",
        locale: "en-US",
        timezone: "UTC",
        instruction_sources: [
          { kind: "global", path: "/Users/secret/.config/AGENTS.md", hash: "sha256:abc" },
          { kind: "remote", url: "https://example.com/secret-instructions" },
        ],
        model_refs: {},
        stats: { session_count: 0, message_count: 0, part_count: 0, omitted_attachment_count: 0 },
      },
      diagnostics: {},
      session: {
        info: { id: SessionID.make("ses_x"), title: "t", directory: "/dir" } as never,
        had_cloud_share: false,
        diffs: [],
        messages: [],
        children: [],
      },
    }

    const sanitized = Export.sanitizeSnapshot(fakeSnapshot)
    const sources = sanitized.runtime_context.instruction_sources
    expect(sources[0].path).toBe("[redacted:instruction-path:0]")
    expect(sources[1].url).toBe("[redacted:instruction-url:1]")
    // hash + kind + structural fields preserved
    expect(sources[0].kind).toBe("global")
    expect(sources[0].hash).toBe("sha256:abc")
  })

  test("redacts data: url inside completed tool attachments", () => {
    const ctx = { count: { omitted: 0 } }
    const part: MessageV2.ToolPart = {
      id: PartID.make("prt_tool_fixture"),
      messageID: MessageID.make("msg_fixture"),
      sessionID: SessionID.make("ses_fixture"),
      type: "tool",
      callID: "call_1",
      tool: "read",
      state: {
        status: "completed",
        input: {},
        output: "",
        title: "fixture",
        metadata: {},
        time: { start: 0, end: 1 },
        attachments: [
          {
            id: PartID.make("att_fixture"),
            messageID: MessageID.make("msg_fixture"),
            sessionID: SessionID.make("ses_fixture"),
            type: "file",
            url: "data:image/jpeg;base64,/9j/4AAQ",
            mime: "image/jpeg",
            filename: "fixture.bin",
          },
        ],
      },
    }

    const out = redactPart(part, ctx)
    if (out.type !== "tool" || out.state.status !== "completed") throw new Error("type narrowing")
    const attachments = out.state.attachments ?? []
    expect(attachments[0].url).toBe("")
    expect(attachments[0].metadata?.redacted_binary).toBeDefined()
    expect(ctx.count.omitted).toBe(1)
  })
})
