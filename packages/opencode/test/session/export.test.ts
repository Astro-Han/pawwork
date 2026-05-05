import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Session as SessionNs } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Log } from "@opencode-ai/core/util/log"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Export, getRuntimeNamespace, redactPart } from "../../src/session/export"
import { Global } from "../../src/global"
import { tmpdir } from "../fixture/fixture"
import { Config } from "../../src/config"
import { TOOL_FAILURE_HINTS } from "../../src/session/tool-failure"

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

  test("resolves project instruction sources from the exported session directory", async () => {
    await using sessionProject = await tmpdir({ git: true })
    await using currentProject = await tmpdir({ git: true })
    await fs.writeFile(path.join(sessionProject.path, "CLAUDE.md"), "session project instructions")
    await fs.writeFile(path.join(currentProject.path, "AGENTS.md"), "current project instructions")

    let sessionID: SessionID | undefined
    await Instance.provide({
      directory: sessionProject.path,
      fn: async () => {
        const root = await SessionNs.create({ title: "export source directory" })
        sessionID = root.id
      },
    })

    try {
      await Instance.provide({
        directory: currentProject.path,
        fn: async () => {
          const result = await AppRuntime.runPromise(Export.session(sessionID!))
          const projectSources = result.runtime_context.instruction_sources.filter(
            (source) => source.kind === "project",
          )
          expect(projectSources.map((source) => source.path)).toContain(path.join(sessionProject.path, "CLAUDE.md"))
          expect(projectSources.map((source) => source.path)).not.toContain(path.join(currentProject.path, "AGENTS.md"))
        },
      })
    } finally {
      if (sessionID) await SessionNs.remove(sessionID)
    }
  })

  test("does not fail export when the session instruction directory is gone", async () => {
    await using sessionProject = await tmpdir({ git: true })
    await using currentProject = await tmpdir({ git: true })

    let sessionID: SessionID | undefined
    await Instance.provide({
      directory: sessionProject.path,
      fn: async () => {
        const root = await SessionNs.create({ title: "missing export source directory" })
        sessionID = root.id
      },
    })

    try {
      await fs.rm(sessionProject.path, { recursive: true, force: true })
      await Instance.provide({
        directory: currentProject.path,
        fn: async () => {
          const result = await AppRuntime.runPromise(Export.session(sessionID!))
          const projectSources = result.runtime_context.instruction_sources.filter(
            (source) => source.kind === "project",
          )
          expect(projectSources).toContainEqual({
            kind: "project",
            path: sessionProject.path,
            hash_unavailable: true,
            reason: "session directory unavailable",
          })
          expect(result.runtime_context.instruction_sources.some((source) => source.kind === "bundled")).toBe(true)
        },
      })
    } finally {
      if (sessionID) await SessionNs.remove(sessionID)
    }
  })

  test("keeps global config instruction provenance when session directory is gone", async () => {
    await using sessionProject = await tmpdir({ git: true })
    await using currentProject = await tmpdir({ git: true })
    await using global = await tmpdir()
    const previousConfig = Global.Path.config
    const previousEnv = process.env.GLOBAL_EXPORT_RULE
    ;(Global.Path as { config: string }).config = global.path
    const globalRules = path.join(global.path, "rules", "global-rules.md")
    const envRules = path.join(global.path, "env-rules.md")
    const fileRules = path.join(global.path, "file-rules.md")
    process.env.GLOBAL_EXPORT_RULE = envRules
    await fs.mkdir(path.join(global.path, "rules"), { recursive: true })
    await fs.writeFile(globalRules, "global config instructions")
    await fs.writeFile(envRules, "env config instructions")
    await fs.writeFile(fileRules, "file config instructions")
    await fs.writeFile(path.join(global.path, "rule-path.txt"), fileRules)
    await fs.writeFile(
      path.join(global.path, "opencode.json"),
      JSON.stringify({
        instructions: [
          "rules/*.md",
          "{env:GLOBAL_EXPORT_RULE}",
          "{file:rule-path.txt}",
          "missing/*.md",
          "https://example.invalid/global-rules.md",
        ],
      }),
    )
    await fs.writeFile(
      path.join(currentProject.path, "opencode.json"),
      JSON.stringify({
        instructions: ["https://example.invalid/current-project.md"],
      }),
    )

    let sessionID: SessionID | undefined
    await Instance.provide({
      directory: sessionProject.path,
      fn: async () => {
        const root = await SessionNs.create({ title: "missing global config provenance" })
        sessionID = root.id
      },
    })

    try {
      await Config.invalidate(true)
      await fs.rm(sessionProject.path, { recursive: true, force: true })
      await Instance.provide({
        directory: currentProject.path,
        fn: async () => {
          const result = await AppRuntime.runPromise(Export.session(sessionID!))
          const sources = result.runtime_context.instruction_sources
          const byPath = new Map(sources.filter((source) => source.path).map((source) => [source.path, source]))
          expect(byPath.get(globalRules)?.reason).toContain("fallback relative path")
          expect(byPath.get(globalRules)?.hash_unavailable).toBe(true)
          expect(byPath.get(envRules)?.hash).toStartWith("sha256:")
          expect(byPath.get(fileRules)?.hash).toStartWith("sha256:")
          expect(sources.map((source) => source.path)).not.toContain(path.join(global.path, "missing", "*.md"))
          expect(sources.map((source) => source.url)).toContain("https://example.invalid/global-rules.md")
          expect(sources.map((source) => source.url)).not.toContain("https://example.invalid/current-project.md")
        },
      })
    } finally {
      ;(Global.Path as { config: string }).config = previousConfig
      if (previousEnv === undefined) delete process.env.GLOBAL_EXPORT_RULE
      else process.env.GLOBAL_EXPORT_RULE = previousEnv
      await Config.invalidate(true)
      if (sessionID) await SessionNs.remove(sessionID)
    }
  })

  test("exports only the loaded PawWork global AGENTS.md source", async () => {
    await using primary = await tmpdir()
    await using legacy = await tmpdir()
    await using project = await tmpdir({ git: true })
    const previousRuntime = process.env.PAWWORK_RUNTIME_NAMESPACE
    const previousHome = process.env.PAWWORK_HOME
    const previousConfigDir = process.env.PAWWORK_CONFIG_DIR
    const previousGlobalConfig = Global.Path.config
    process.env.PAWWORK_RUNTIME_NAMESPACE = "pawwork"
    process.env.PAWWORK_HOME = primary.path
    delete process.env.PAWWORK_CONFIG_DIR
    ;(Global.Path as { config: string }).config = legacy.path

    try {
      await fs.writeFile(path.join(primary.path, "AGENTS.md"), "primary instructions")
      await fs.writeFile(path.join(legacy.path, "AGENTS.md"), "legacy instructions")

      await Instance.provide({
        directory: project.path,
        fn: async () => {
          const root = await SessionNs.create({ title: "instruction provenance" })
          try {
            const result = await AppRuntime.runPromise(Export.session(root.id))
            const globalSources = result.runtime_context.instruction_sources.filter(
              (source) => source.kind === "global",
            )
            expect(globalSources).toHaveLength(1)
            expect(globalSources[0].path).toBe(path.join(primary.path, "AGENTS.md"))
          } finally {
            await SessionNs.remove(root.id)
          }
        },
      })
    } finally {
      ;(Global.Path as { config: string }).config = previousGlobalConfig
      if (previousRuntime === undefined) delete process.env.PAWWORK_RUNTIME_NAMESPACE
      else process.env.PAWWORK_RUNTIME_NAMESPACE = previousRuntime
      if (previousHome === undefined) delete process.env.PAWWORK_HOME
      else process.env.PAWWORK_HOME = previousHome
      if (previousConfigDir === undefined) delete process.env.PAWWORK_CONFIG_DIR
      else process.env.PAWWORK_CONFIG_DIR = previousConfigDir
    }
  })

  test("does not export lower-priority PawWork global AGENTS.md when the first existing candidate is empty", async () => {
    await using primary = await tmpdir()
    await using legacy = await tmpdir()
    await using project = await tmpdir({ git: true })
    const previousRuntime = process.env.PAWWORK_RUNTIME_NAMESPACE
    const previousHome = process.env.PAWWORK_HOME
    const previousConfigDir = process.env.PAWWORK_CONFIG_DIR
    const previousGlobalConfig = Global.Path.config
    process.env.PAWWORK_RUNTIME_NAMESPACE = "pawwork"
    process.env.PAWWORK_HOME = primary.path
    delete process.env.PAWWORK_CONFIG_DIR
    ;(Global.Path as { config: string }).config = legacy.path

    try {
      await fs.writeFile(path.join(primary.path, "AGENTS.md"), "")
      await fs.writeFile(path.join(legacy.path, "AGENTS.md"), "legacy instructions")

      await Instance.provide({
        directory: project.path,
        fn: async () => {
          const root = await SessionNs.create({ title: "empty instruction provenance" })
          try {
            const result = await AppRuntime.runPromise(Export.session(root.id))
            const globalSources = result.runtime_context.instruction_sources.filter(
              (source) => source.kind === "global",
            )
            expect(globalSources).toHaveLength(0)
          } finally {
            await SessionNs.remove(root.id)
          }
        },
      })
    } finally {
      ;(Global.Path as { config: string }).config = previousGlobalConfig
      if (previousRuntime === undefined) delete process.env.PAWWORK_RUNTIME_NAMESPACE
      else process.env.PAWWORK_RUNTIME_NAMESPACE = previousRuntime
      if (previousHome === undefined) delete process.env.PAWWORK_HOME
      else process.env.PAWWORK_HOME = previousHome
      if (previousConfigDir === undefined) delete process.env.PAWWORK_CONFIG_DIR
      else process.env.PAWWORK_CONFIG_DIR = previousConfigDir
    }
  })

  test("exports loaded project CLAUDE.md instruction source", async () => {
    await using project = await tmpdir({
      git: true,
      init: async (dir) => {
        await fs.writeFile(path.join(dir, "CLAUDE.md"), "project claude instructions")
      },
    })
    await using globalConfig = await tmpdir()
    const previousRuntime = process.env.PAWWORK_RUNTIME_NAMESPACE
    const previousDisableClaude = process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT
    const previousGlobalConfig = Global.Path.config
    delete process.env.PAWWORK_RUNTIME_NAMESPACE
    delete process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT
    ;(Global.Path as { config: string }).config = globalConfig.path

    try {
      await Instance.provide({
        directory: project.path,
        fn: async () => {
          const root = await SessionNs.create({ title: "claude provenance" })
          try {
            const result = await AppRuntime.runPromise(Export.session(root.id))
            const projectSources = result.runtime_context.instruction_sources.filter(
              (source) => source.kind === "project",
            )
            expect(projectSources.some((source) => source.path === path.join(project.path, "CLAUDE.md"))).toBe(true)
          } finally {
            await SessionNs.remove(root.id)
          }
        },
      })
    } finally {
      ;(Global.Path as { config: string }).config = previousGlobalConfig
      if (previousRuntime === undefined) delete process.env.PAWWORK_RUNTIME_NAMESPACE
      else process.env.PAWWORK_RUNTIME_NAMESPACE = previousRuntime
      if (previousDisableClaude === undefined) delete process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT
      else process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT = previousDisableClaude
    }
  })

  test("exports loaded local and configured remote config.instructions sources", async () => {
    await using project = await tmpdir({ git: true })
    await using globalConfig = await tmpdir()
    await using instructions = await tmpdir({
      init: async (dir) => {
        await fs.writeFile(path.join(dir, "extra.md"), "local config instructions")
      },
    })
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response("remote config instructions")
      },
    })
    const previousConfig = process.env.OPENCODE_CONFIG_CONTENT
    const previousRuntime = process.env.PAWWORK_RUNTIME_NAMESPACE
    const previousGlobalConfig = Global.Path.config
    delete process.env.PAWWORK_RUNTIME_NAMESPACE
    ;(Global.Path as { config: string }).config = globalConfig.path
    const localFile = path.join(instructions.path, "extra.md")
    const url = `${server.url}instructions.md`
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      instructions: [localFile, url],
    })
    await Config.invalidate(true)

    try {
      await Instance.provide({
        directory: project.path,
        fn: async () => {
          const root = await SessionNs.create({ title: "config instruction provenance" })
          try {
            const result = await AppRuntime.runPromise(Export.session(root.id))
            expect(
              result.runtime_context.instruction_sources.some(
                (source) => source.kind === "config" && source.path === localFile,
              ),
            ).toBe(true)
            const remote = result.runtime_context.instruction_sources.find(
              (source) => source.kind === "remote" && source.url === url,
            )
            expect(remote?.hash_unavailable).toBe(true)
          } finally {
            await SessionNs.remove(root.id)
          }
        },
      })
    } finally {
      server.stop(true)
      ;(Global.Path as { config: string }).config = previousGlobalConfig
      if (previousRuntime === undefined) delete process.env.PAWWORK_RUNTIME_NAMESPACE
      else process.env.PAWWORK_RUNTIME_NAMESPACE = previousRuntime
      if (previousConfig === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
      else process.env.OPENCODE_CONFIG_CONTENT = previousConfig
      await Config.invalidate(true)
    }
  })

  test("exports configured remote config.instructions without fetching the URL", async () => {
    await using project = await tmpdir({ git: true })
    await using globalConfig = await tmpdir()
    let requests = 0
    const server = Bun.serve({
      port: 0,
      fetch() {
        requests++
        return new Response("remote config instructions")
      },
    })
    const previousConfig = process.env.OPENCODE_CONFIG_CONTENT
    const previousRuntime = process.env.PAWWORK_RUNTIME_NAMESPACE
    const previousGlobalConfig = Global.Path.config
    delete process.env.PAWWORK_RUNTIME_NAMESPACE
    ;(Global.Path as { config: string }).config = globalConfig.path
    const url = `${server.url}instructions.md`
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      instructions: [url],
    })
    await Config.invalidate(true)

    try {
      await Instance.provide({
        directory: project.path,
        fn: async () => {
          const root = await SessionNs.create({ title: "remote instruction provenance" })
          try {
            const result = await AppRuntime.runPromise(Export.session(root.id))
            const source = result.runtime_context.instruction_sources.find(
              (item) => item.kind === "remote" && item.url === url,
            )
            expect(source?.hash_unavailable).toBe(true)
            expect(requests).toBe(0)
          } finally {
            await SessionNs.remove(root.id)
          }
        },
      })
    } finally {
      server.stop(true)
      ;(Global.Path as { config: string }).config = previousGlobalConfig
      if (previousRuntime === undefined) delete process.env.PAWWORK_RUNTIME_NAMESPACE
      else process.env.PAWWORK_RUNTIME_NAMESPACE = previousRuntime
      if (previousConfig === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
      else process.env.OPENCODE_CONFIG_CONTENT = previousConfig
      await Config.invalidate(true)
    }
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

describe("Export.redactPart sensitive tool metadata", () => {
  test("redacts sensitive tool input and metadata", () => {
    const part: MessageV2.ToolPart = {
      id: PartID.make("prt_sensitive_tool"),
      messageID: MessageID.make("msg_sensitive_tool"),
      sessionID: SessionID.make("ses_sensitive_tool"),
      type: "tool",
      tool: "edit",
      callID: "call_sensitive_tool",
      state: {
        status: "completed",
        input: {
          filePath: "/tmp/project/.env",
          oldString: "TOKEN=old-secret",
          newString: "TOKEN=new-secret",
        },
        output: "Edit applied successfully.",
        title: ".env",
        metadata: {
          diff: "@@\n-TOKEN=old-secret\n+TOKEN=new-secret\n",
          filediff: {
            file: "/tmp/project/.env",
            patch: "@@\n-TOKEN=old-secret\n+TOKEN=new-secret\n",
            additions: 1,
            deletions: 1,
          },
          diagnostics: {
            failure: {
              errorKind: "environment",
              recoveryHint: "check /Users/alice/.env",
            },
          },
        },
        time: { start: 1, end: 2 },
      },
    }

    const redacted = redactPart(part, { count: { omitted: 0 } })
    const serialized = JSON.stringify(redacted)

    expect(serialized).not.toContain("old-secret")
    expect(serialized).not.toContain("new-secret")
    expect(serialized).not.toContain("@@")
    expect((redacted as MessageV2.ToolPart).state).toMatchObject({
      input: { filePath: "/tmp/project/.env", sensitive: true },
      output: "Sensitive file updated.",
      metadata: {
        diagnostics: {
          failure: {
            errorKind: "environment",
            recoveryHint: TOOL_FAILURE_HINTS.environment,
          },
        },
        filediff: {
          file: "/tmp/project/.env",
          status: "modified",
          sensitive: true,
        },
      },
    })
  })
})

describe("Export.deriveSnapshotDiagnostics", () => {
  const sessionID = SessionID.make("ses_diag")
  const messageID = MessageID.make("msg_assistant")
  const userID = MessageID.make("msg_user")

  function blockToolPart(): MessageV2.ToolPart {
    return {
      id: PartID.make("prt_loop_block"),
      messageID,
      sessionID,
      type: "tool",
      tool: "webfetch",
      callID: "call_block",
      state: {
        status: "error",
        input: { url: "https://example.com/missing.md" },
        error: "blocked by PawWork: 5 same target failures",
        metadata: {
          diagnostics: {
            loop: {
              loopAction: "block",
              loopType: "target",
              loopCompletedFailures: 5,
              loopSigKey: "target:webfetch:abc",
            },
          },
        },
        time: { start: 1, end: 2 },
      },
    }
  }

  function makeTree(): Export.Tree {
    return {
      info: {
        id: sessionID,
        title: "loop test",
        time: { created: 1 },
        version: "0",
      } as unknown as Export.Tree["info"],
      had_cloud_share: false,
      diffs: [],
      messages: [
        {
          info: {
            id: messageID,
            role: "assistant",
            sessionID,
            mode: "build",
            agent: "build",
            path: { cwd: "/tmp", root: "/tmp" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test-model",
            providerID: "test",
            parentID: userID,
            time: { created: 1 },
          } as MessageV2.Assistant,
          parts: [blockToolPart()],
        },
      ],
      children: [],
    }
  }

  test("emits loop.last for the latest synthetic block tool part", () => {
    const tree = makeTree()
    const result = Export.deriveSnapshotDiagnostics(tree)
    expect(result.loop?.last).toBeDefined()
    expect(result.loop?.last?.type).toBe("same_target")
    expect(result.loop?.last?.action).toBe("block")
    expect(result.loop?.last?.tool).toBe("webfetch")
    expect(result.loop?.last?.completedFailures).toBe(5)
    expect(result.loop?.last?.parentID).toBe(userID)
  })

  test("returns empty when no block tool part exists", () => {
    const tree: Export.Tree = { ...makeTree(), messages: [] }
    expect(Export.deriveSnapshotDiagnostics(tree)).toEqual({})
  })

  test("picks the block with the latest timestamp across child trees, not DFS order", () => {
    const rootInfo = makeAssistantInfo()
    const childInfo = makeAssistantInfo()
    const olderInChild = blockToolPartAt(childInfo.id, 50, "older-child")
    const newerInRoot = blockToolPartAt(rootInfo.id, 100, "newer-root")
    const tree: Export.Tree = {
      ...makeTree(),
      messages: [
        {
          info: rootInfo,
          parts: [newerInRoot],
        },
      ],
      children: [
        {
          ...makeTree(),
          messages: [
            {
              info: childInfo,
              parts: [olderInChild],
            },
          ],
        },
      ],
    }
    const result = Export.deriveSnapshotDiagnostics(tree)
    expect(result.loop?.last?.completedFailures).toBe(100)
  })

  test("picks stop over earlier block when stop is the terminal action", () => {
    const info = makeAssistantInfo()
    const block = blockToolPartAt(info.id, 100, "early-block")
    const stop = stopToolPartAt(info.id, 200, "final-stop")
    const tree: Export.Tree = {
      ...makeTree(),
      messages: [
        {
          info,
          parts: [block, stop],
        },
      ],
      children: [],
    }
    const result = Export.deriveSnapshotDiagnostics(tree)
    expect(result.loop?.last?.action).toBe("stop")
    expect(result.loop?.last?.completedFailures).toBe(200)
  })

  test("includes stop tool part even when no block exists in tree", () => {
    const info = makeAssistantInfo()
    const stop = stopToolPartAt(info.id, 50, "lone-stop")
    const tree: Export.Tree = {
      ...makeTree(),
      messages: [
        {
          info,
          parts: [stop],
        },
      ],
      children: [],
    }
    const result = Export.deriveSnapshotDiagnostics(tree)
    expect(result.loop?.last?.action).toBe("stop")
  })

  test("exports success loop diagnostics with neutral completed count", () => {
    const info = makeAssistantInfo()
    const stop = successStopToolPartAt(info.id, 4, "success-stop")
    const tree: Export.Tree = {
      ...makeTree(),
      messages: [
        {
          info,
          parts: [stop],
        },
      ],
      children: [],
    }
    const result = Export.deriveSnapshotDiagnostics(tree)
    expect(result.loop?.last?.action).toBe("stop")
    expect(result.loop?.last?.outcome).toBe("success")
    expect(result.loop?.last?.completedCount).toBe(4)
    expect(result.loop?.last?.occurrenceCount).toBe(5)
    expect(result.loop?.last?.completedFailures).toBeUndefined()
  })

  test("exports attempted input for synthetic block diagnostics", () => {
    const info = makeAssistantInfo()
    const block = blockToolPartAt(info.id, 100, "attempted-input")
    const attemptedInput = { filePath: "/tmp/project/src/session.ts", offset: 360, limit: 80 }
    if (block.state.status !== "error") throw new Error("expected error tool state")
    block.state.metadata = {
      ...block.state.metadata,
      diagnostics: {
        loop: {
          ...block.state.metadata?.diagnostics?.loop,
          attemptedInput,
        },
      },
    }
    const tree: Export.Tree = {
      ...makeTree(),
      messages: [
        {
          info,
          parts: [block],
        },
      ],
      children: [],
    }

    const result = Export.deriveSnapshotDiagnostics(tree)
    expect(result.loop?.last?.attemptedInput).toEqual(attemptedInput)
  })
})

let assistantSeq = 0
function makeAssistantInfo(): MessageV2.Assistant {
  const sessionID = SessionID.make("ses_diag")
  assistantSeq += 1
  const messageID = MessageID.make(`msg_assistant_seq_${assistantSeq}`)
  return {
    id: messageID,
    role: "assistant",
    sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: "test-model",
    providerID: "test",
    parentID: MessageID.make("msg_user"),
    time: { created: 1 },
  } as MessageV2.Assistant
}

function blockToolPartAt(messageID: MessageID, end: number, tag: string): MessageV2.ToolPart {
  return {
    id: PartID.make("prt_block_" + tag),
    messageID,
    sessionID: SessionID.make("ses_diag"),
    type: "tool",
    tool: "webfetch",
    callID: "call_" + tag,
    state: {
      status: "error",
      input: { url: "https://x.com/" + tag },
      error: "blocked by PawWork",
      metadata: {
        diagnostics: {
          loop: {
            loopAction: "block",
            loopType: "target",
            loopCompletedFailures: end,
            loopSigKey: "target:webfetch:" + tag,
          },
        },
      },
      time: { start: 1, end },
    },
  }
}

function stopToolPartAt(messageID: MessageID, end: number, tag: string): MessageV2.ToolPart {
  return {
    id: PartID.make("prt_stop_" + tag),
    messageID,
    sessionID: SessionID.make("ses_diag"),
    type: "tool",
    tool: "webfetch",
    callID: "call_stop_" + tag,
    state: {
      status: "error",
      input: { url: "https://x.com/" + tag },
      error: "halted by PawWork",
      metadata: {
        diagnostics: {
          loop: {
            loopAction: "stop",
            loopType: "target",
            loopCompletedFailures: end,
            loopSigKey: "target:webfetch:" + tag,
          },
        },
      },
      time: { start: 1, end },
    },
  }
}

function successStopToolPartAt(messageID: MessageID, count: number, tag: string): MessageV2.ToolPart {
  return {
    id: PartID.make("prt_success_stop_" + tag),
    messageID,
    sessionID: SessionID.make("ses_diag"),
    type: "tool",
    tool: "grep",
    callID: "call_success_stop_" + tag,
    state: {
      status: "error",
      input: { pattern: "compaction", path: "/tmp/src" },
      error: "halted by PawWork",
      metadata: {
        diagnostics: {
          loop: {
            loopAction: "stop",
            loopType: "input",
            outcome: "success",
            loopCompletedCount: count,
            loopOccurrenceCount: 5,
            loopSigKey: "success:input:grep:" + tag,
          },
        },
      },
      time: { start: 1, end: count },
    },
  }
}

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
        diffs: [{ file: "/Users/secret/code.ts", patch: "@@ -1 +1 @@\n-secret\n+leak", additions: 1, deletions: 1 }],
        messages: [],
        children: [
          {
            info: { id: SessionID.make("ses_y"), title: "child", directory: "/dir" } as never,
            had_cloud_share: false,
            diffs: [{ file: "/Users/secret/child.ts", patch: "child secret", additions: 0, deletions: 0 }],
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

  test("sanitizeSnapshot redacts loop attemptedInput and tool errors", () => {
    const messageID = MessageID.make("msg_sensitive_loop")
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
      diagnostics: {
        loop: {
          last: {
            parentID: "msg_user",
            type: "same_input",
            action: "block",
            tool: "bash",
            attemptedInput: { command: "cat /Users/secret/.env", token: "sk-secret" },
          },
        },
      },
      session: {
        info: { id: SessionID.make("ses_x"), title: "t", directory: "/dir" } as never,
        had_cloud_share: false,
        diffs: [],
        messages: [
          {
            info: {
              id: messageID,
              role: "assistant",
              sessionID: SessionID.make("ses_x"),
              mode: "build",
              agent: "build",
              path: { cwd: "/tmp", root: "/tmp" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: "test-model",
              providerID: "test",
              parentID: MessageID.make("msg_user"),
              time: { created: 1 },
            } as MessageV2.Assistant,
            parts: [
              {
                id: PartID.make("prt_error"),
                messageID,
                sessionID: SessionID.make("ses_x"),
                type: "tool",
                tool: "bash",
                callID: "call_error",
                state: {
                  status: "error",
                  input: { command: "cat /Users/secret/.env" },
                  error: "failed to read /Users/secret/.env",
                  metadata: {
                    commandId: "cmd-secret",
                    diagnostics: {
                      failure: {
                        errorKind: "environment",
                        recoveryHint: "check /Users/secret/.env",
                      },
                    },
                  },
                  time: { start: 1, end: 2 },
                },
              },
            ],
          },
        ],
        children: [],
      },
    }

    const sanitized = Export.sanitizeSnapshot(fakeSnapshot)
    expect(sanitized.diagnostics.loop?.last?.attemptedInput).toEqual({ redacted: "loop-attempted-input:msg_user" })
    const tool = sanitized.session.messages[0].parts[0]
    if (tool.type !== "tool" || tool.state.status !== "error") throw new Error("expected error tool part")
    expect(tool.state.input).toEqual({ redacted: "tool-input:prt_error" })
    expect(tool.state.error).toBe("[redacted:tool-error:prt_error]")
    expect(tool.state.metadata).toEqual({
      redacted: "tool-state-metadata:prt_error",
      diagnostics: {
        failure: {
          errorKind: "environment",
          recoveryHint: TOOL_FAILURE_HINTS.environment,
        },
      },
    })
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
