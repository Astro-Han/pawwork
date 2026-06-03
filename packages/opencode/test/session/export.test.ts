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
import { LLMTrace } from "../../src/session/llm-trace"
import { RunObservability } from "../../src/session/run-observability"
import { RunLifecycle } from "../../src/session/run-lifecycle"

const projectRoot = path.join(__dirname, "../..")
void Log.init({ print: false })

async function removeLoadedSessionProjectDirectory(dir: string) {
  await Instance.disposeDirectory(dir)
  await fs.rm(dir, {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 30 : 5,
    retryDelay: 100,
  })
}

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
      await removeLoadedSessionProjectDirectory(sessionProject.path)
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
    const previousRuntime = process.env.PAWWORK_RUNTIME_NAMESPACE
    const globalRules = path.join(global.path, "rules", "global-rules.md")
    const envRules = path.join(global.path, "env-rules.md")
    const fileRules = path.join(global.path, "file-rules.md")

    let sessionID: SessionID | undefined
    try {
      delete process.env.PAWWORK_RUNTIME_NAMESPACE
      ;(Global.Path as { config: string }).config = global.path
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
      await Instance.provide({
        directory: sessionProject.path,
        fn: async () => {
          const root = await SessionNs.create({ title: "missing global config provenance" })
          sessionID = root.id
        },
      })

      await Config.invalidate(true)
      await removeLoadedSessionProjectDirectory(sessionProject.path)
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
      if (previousRuntime === undefined) delete process.env.PAWWORK_RUNTIME_NAMESPACE
      else process.env.PAWWORK_RUNTIME_NAMESPACE = previousRuntime
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

  test("exports assistant llm traces from covered session messages", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const root = await SessionNs.create({ title: "llm trace export" })
        try {
          const userID = MessageID.ascending()
          const assistantID = MessageID.ascending()
          const trace: LLMTrace.Summary = {
            schema_version: 1,
            trace_id: assistantID,
            session_id: root.id,
            message_id: assistantID,
            parent_message_id: userID,
            provider: "test",
            model: "test-model",
            agent: "build",
            request: {
              streaming: true,
              tool_count: 0,
              small: false,
              reasoning_capability: true,
            },
            stream_events: {
              start: 1,
              start_step: 1,
              finish_step: 1,
              finish: 1,
              text_start: 1,
              text_delta: 2,
              text_end: 1,
              reasoning_start: 0,
              reasoning_delta: 0,
              reasoning_end: 0,
              tool_input_start: 0,
              tool_input_delta: 0,
              tool_input_end: 0,
              tool_call: 0,
              tool_result: 0,
              tool_error: 0,
              error: 0,
              finish_reason: "stop",
            },
            stored_parts: {
              text: 1,
              reasoning: 0,
              tool: 0,
              step_start: 1,
              step_finish: 1,
              patch: 0,
              file: 0,
              other: 0,
            },
            tokens: {
              input: 3,
              output: 5,
              reasoning: 0,
              cache_read: 0,
              cache_write: 0,
            },
            flags: { empty_completion: false },
            created_at: 1,
            completed_at: 2,
          }

          await SessionNs.updateMessage({
            id: userID,
            sessionID: root.id,
            role: "user",
            time: { created: Date.now() },
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
          } as MessageV2.User)
          await SessionNs.updateMessage({
            id: assistantID,
            role: "assistant",
            sessionID: root.id,
            mode: "build",
            agent: "build",
            path: { cwd: projectRoot, root: projectRoot },
            cost: 0,
            tokens: { input: 3, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test-model",
            providerID: "test",
            parentID: userID,
            time: { created: Date.now(), completed: Date.now() },
            finish: "stop",
            diagnostics: { llm_trace: trace },
          } as MessageV2.Assistant)

          const result = await AppRuntime.runPromise(Export.session(root.id))
          expect(result.diagnostics.llm_trace_schema_version).toBe(1)
          expect(result.diagnostics.llm_traces).toEqual([trace])
        } finally {
          await SessionNs.remove(root.id)
        }
      },
    })
  })

  test("omits llm_traces when no exported assistant message has trace diagnostics", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const root = await SessionNs.create({ title: "no llm trace" })
        try {
          const result = await AppRuntime.runPromise(Export.session(root.id))
          expect(result.diagnostics.llm_traces).toBeUndefined()
          expect(result.diagnostics.llm_trace_schema_version).toBeUndefined()
        } finally {
          await SessionNs.remove(root.id)
        }
      },
    })
  })

  test("collects run observability diagnostics as a top-level projection", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const root = await SessionNs.create({ title: "run observability" })
        const userID = MessageID.make("msg_run_obs_user")
        const assistantID = MessageID.make("msg_run_obs_assistant")
        const summary: RunObservability.Summary = {
          schema_version: 1,
          run_id: RunObservability.RunID.make("run_export"),
          trace_id: assistantID,
          session_id: root.id,
          message_id: assistantID,
          parent_message_id: userID,
          provider: "test",
          model: "test-model",
          created_at: 10,
          completed_at: 20,
          classification: "external_stream_disconnect",
          summary_key: RunObservability.summaryKeyFor("external_stream_disconnect", "provider_progress_socket_closed"),
          retry_safety: {
            recommendation: "candidate_safe_auto_retry",
            confidence: "medium",
            reason: "no_visible_output_or_tool_execution",
            safety_scope: "user_visible_and_tool_side_effects",
          },
          attempts: [],
          provider_progress_seen: true,
          visible_output_seen: false,
          tool_call_seen: false,
          tool_input_started: false,
          tool_input_completed: false,
          tool_call_materialized: false,
          tool_execution_started: false,
          read_only_tool_started: false,
          unsafe_side_effect_started: false,
          unsafe_side_effect_kinds: [],
          side_effect_facts_complete: true,
          durations_ms: { total: 10 },
          error: { name: "TypeError", message: "terminated", cause_code: "UND_ERR_SOCKET" },
        }
        try {
          await SessionNs.updateMessage({
            id: userID,
            sessionID: root.id,
            role: "user",
            time: { created: Date.now() },
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
          } as MessageV2.User)
          await SessionNs.updateMessage({
            id: assistantID,
            role: "assistant",
            sessionID: root.id,
            mode: "build",
            agent: "build",
            path: { cwd: projectRoot, root: projectRoot },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test-model",
            providerID: "test",
            parentID: userID,
            time: { created: 10, completed: 20 },
            finish: "error",
            diagnostics: { run_observability: summary },
          } as MessageV2.Assistant)

          const result = await AppRuntime.runPromise(Export.session(root.id))
          expect(result.diagnostics.run_observability_schema_version).toBe(1)
          expect(result.diagnostics.run_observability).toEqual([summary])
        } finally {
          await SessionNs.remove(root.id)
        }
      },
    })
  })

  test("collects run lifecycle diagnostics from user messages", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const root = await SessionNs.create({ title: "run lifecycle" })
        const userID = MessageID.make("msg_run_lifecycle_user")
        const events = [
          {
            schema_version: 1,
            type: "user_message_saved",
            session_id: root.id,
            message_id: userID,
            at: 10,
          },
          {
            schema_version: 1,
            type: "run_wait_started",
            session_id: root.id,
            message_id: userID,
            at: 20,
            reason: "lifecycle_close",
            lifecycle: {
              action_id: "lifecycle:instance_dispose_all:test",
              kind: "instance_dispose_all",
              initiated_at: 5,
              affected_directory_keys: ["dir:test"],
              origin: {
                source: "server_handler",
                operation: "instance.disposeAll",
                reason: "test",
              },
            },
          },
        ]
        try {
          await SessionNs.updateMessage({
            id: userID,
            sessionID: root.id,
            role: "user",
            time: { created: 10 },
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
            diagnostics: { run_lifecycle: events },
          } as MessageV2.User)

          const result = await AppRuntime.runPromise(Export.session(root.id))
          expect((result.diagnostics as any).run_lifecycle_schema_version).toBe(1)
          expect((result.diagnostics as any).run_lifecycle).toEqual(events)
        } finally {
          await SessionNs.remove(root.id)
        }
      },
    })
  })

  test("collects abort and title generation diagnostics from assistant messages", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const root = await SessionNs.create({ title: "diag summary" })
        const userID = MessageID.make("msg_diag_user")
        const assistantID = MessageID.make("msg_diag_assistant")
        try {
          await SessionNs.updateMessage({
            id: userID,
            sessionID: root.id,
            role: "user",
            time: { created: Date.now() },
            agent: "build",
            model: { providerID: "test", modelID: "test-model" },
          } as MessageV2.User)
          await SessionNs.updateMessage({
            id: assistantID,
            role: "assistant",
            sessionID: root.id,
            mode: "build",
            agent: "build",
            path: { cwd: projectRoot, root: projectRoot },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: "test-model",
            providerID: "test",
            parentID: userID,
            time: { created: 10, completed: 20 },
            finish: "error",
            diagnostics: {
              abort: {
                source: "session.prompt.cancel",
                reason: "cancel",
                title_generation_state: "completed_after_abort",
                propagation_point: "session.prompt.loop.onInterrupt",
                error_name: "MessageAbortedError",
                error_message: "Aborted",
                via_ctx_abort: false,
                recorded_at: 21,
              },
              title_generation: {
                source: "ensureTitle",
                parent_message_id: userID,
                started_at: 11,
                completed_at: 19,
                success: true,
                applied: true,
              },
            },
          } as MessageV2.Assistant)

          const result = await AppRuntime.runPromise(Export.session(root.id))
          expect(result.diagnostics.aborts).toEqual([
            {
              session_id: root.id,
              message_id: assistantID,
              parent_id: userID,
              source: "session.prompt.cancel",
              reason: "cancel",
              title_generation_state: "completed_after_abort",
              propagation_point: "session.prompt.loop.onInterrupt",
              error_name: "MessageAbortedError",
              error_message: "Aborted",
              via_ctx_abort: false,
              recorded_at: 21,
            },
          ])
          expect(result.diagnostics.title_generations).toEqual([
            {
              session_id: root.id,
              message_id: assistantID,
              parent_id: userID,
              source: "ensureTitle",
              started_at: 11,
              completed_at: 19,
              success: true,
              applied: true,
            },
          ])
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

  test("sanitizeSnapshot redacts abort and title generation error messages", () => {
    const fakeSnapshot: Export.Snapshot = {
      schema_version: 1,
      format: "pawwork-session-export",
      exported_at: 0,
      root_session_id: SessionID.make("ses_diag"),
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
        aborts: [
          {
            session_id: SessionID.make("ses_diag"),
            message_id: MessageID.make("msg_abort"),
            error_message: "failed to read /Users/secret/.env",
          },
        ],
        title_generations: [
          {
            session_id: SessionID.make("ses_diag"),
            message_id: MessageID.make("msg_title"),
            started_at: 1,
            success: false,
            error_message: "provider rejected /Users/secret/.env",
          },
        ],
      },
      session: {
        info: { id: SessionID.make("ses_diag"), title: "t", directory: "/dir" } as never,
        had_cloud_share: false,
        diffs: [],
        messages: [],
        children: [],
      },
    }

    const sanitized = Export.sanitizeSnapshot(fakeSnapshot)
    expect(sanitized.diagnostics.aborts?.[0]?.error_message).toBe("[redacted:abort-error-message:0]")
    expect(sanitized.diagnostics.title_generations?.[0]?.error_message).toBe(
      "[redacted:title-generation-error-message:0]",
    )
  })

  test("sanitizeSnapshot redacts llm stream diagnostics in top-level and session tree copies", () => {
    const rawTrace = {
      schema_version: 1 as const,
      trace_id: MessageID.make("msg_trace_sensitive"),
      session_id: SessionID.make("ses_trace_sensitive"),
      message_id: MessageID.make("msg_trace_sensitive"),
      provider: "test",
      model: "model",
      agent: "build",
      stream_events: {
        start: 0,
        start_step: 0,
        finish_step: 0,
        finish: 0,
        text_start: 0,
        text_delta: 0,
        text_end: 0,
        reasoning_start: 0,
        reasoning_delta: 0,
        reasoning_end: 0,
        tool_input_start: 0,
        tool_input_delta: 0,
        tool_input_end: 0,
        tool_call: 0,
        tool_result: 0,
        tool_error: 0,
        error: 1,
      },
      stored_parts: { text: 0, reasoning: 0, tool: 0, step_start: 0, step_finish: 0, patch: 0, file: 0, other: 0 },
      flags: { empty_completion: true, stream_error: true },
      created_at: 1,
      stream: {
        schema_version: 2,
        legacy_v1_counters: "terminal_attempt",
        timeline: { collector_created_at: 1 },
        watchdog: {
          connect_timeout_ms: 30_000,
          stream_timeout_ms: 600_000,
          provider_progressed: true,
          phase_at_end: "between_provider_events",
          fired: false,
        },
        error: {
          boundary: "sdk_transport",
          confidence: "low",
          evidence: ["iterator_error"],
          name: "TypeError",
          message: "failed https://secret.example.invalid/body token sk-private /Users/alice/project/file.ts",
          cause_message: "Authorization: Bearer secret",
          stack_hint: "at /Users/alice/project/file.ts:1:1",
          private_raw_body: "private response body should not export",
          url: "https://secret.example.invalid/raw",
        },
        provider: {
          safe_headers: {
            "x-request-id": "req_123",
            authorization: "Bearer secret",
            cookie: "session=secret",
          },
        },
        prompt: "private prompt should not export",
        tool_args: { command: "cat /Users/alice/.env" },
        raw_body: "raw provider body should not export",
        url: "https://secret.example.invalid/top-level",
        local_path: "/Users/alice/project/private.txt",
      },
    } satisfies LLMTrace.Summary

    const fakeSnapshot: Export.Snapshot = {
      schema_version: 1,
      format: "pawwork-session-export",
      exported_at: 1,
      root_session_id: SessionID.make("ses_trace_sensitive"),
      runtime_context: {
        app_version: "test",
        runtime_namespace: "pawwork",
        platform: process.platform,
        os_version: "test",
        locale: "en-US",
        timezone: "UTC",
        instruction_sources: [],
        model_refs: {},
        stats: { session_count: 1, message_count: 1, part_count: 0, omitted_attachment_count: 0 },
      },
      diagnostics: { llm_trace_schema_version: 1, llm_traces: [rawTrace] },
      session: {
        info: {
          id: SessionID.make("ses_trace_sensitive"),
          version: "0.0.0",
          time: { created: 1, updated: 1 },
          title: "x",
          directory: "/tmp/project",
        } as SessionNs.Info,
        had_cloud_share: false,
        diffs: [],
        messages: [
          {
            info: {
              id: MessageID.make("msg_trace_sensitive"),
              role: "assistant",
              sessionID: SessionID.make("ses_trace_sensitive"),
              parentID: MessageID.make("msg_parent_sensitive"),
              mode: "build",
              agent: "build",
              path: { cwd: "/tmp/project", root: "/tmp/project" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: "model",
              providerID: "test",
              time: { created: 1 },
              diagnostics: { llm_trace: rawTrace },
            } as MessageV2.Assistant,
            parts: [],
          },
        ],
        children: [],
      },
    }

    const sanitized = Export.sanitizeSnapshot(fakeSnapshot)
    const serialized = JSON.stringify(sanitized)
    expect(serialized).not.toContain("secret.example.invalid")
    expect(serialized).not.toContain("sk-private")
    expect(serialized).not.toContain("/Users/alice")
    expect(serialized).not.toContain("Bearer secret")
    expect(serialized).not.toContain("session=secret")
    expect(serialized).not.toContain("private response body should not export")
    expect(serialized).not.toContain("private_raw_body")
    expect(serialized).not.toContain("private prompt should not export")
    expect(serialized).not.toContain("raw provider body should not export")
    expect(serialized).not.toContain("top-level")
    expect(serialized).not.toContain("private.txt")
    expect(serialized).not.toContain("tool_args")
    expect(sanitized.diagnostics.llm_traces?.[0]?.stream?.error).not.toHaveProperty("url")
    expect(sanitized.diagnostics.llm_traces?.[0]?.stream).not.toHaveProperty("prompt")
    expect(sanitized.diagnostics.llm_traces?.[0]?.stream).not.toHaveProperty("raw_body")
    expect(sanitized.diagnostics.llm_traces?.[0]?.stream?.provider?.safe_headers).toEqual({
      "x-request-id": "req_123",
    })
    expect(
      sanitized.session.messages[0].info.role === "assistant"
        ? sanitized.session.messages[0].info.diagnostics?.llm_trace?.stream?.provider?.safe_headers
        : undefined,
    ).toEqual({ "x-request-id": "req_123" })
  })

  test("sanitizeSnapshot redacts run lifecycle diagnostics in top-level and session tree copies", () => {
    const lifecycleEvent: RunLifecycle.Event = {
      schema_version: 1,
      type: "run_wait_started",
      session_id: SessionID.make("ses_lifecycle_sensitive"),
      message_id: MessageID.make("msg_lifecycle_sensitive"),
      at: 1,
      reason: "lifecycle_close /Users/alice/private-project token-secret",
      lifecycle: {
        action_id: "lifecycle:instance_dispose_all:test",
        kind: "instance_dispose_all",
        initiated_at: 1,
        initiated_monotonic_ms: 2,
        affected_directory_keys: ["dir:safehashed"],
        origin: {
          source: "server_handler",
          operation: "instance.disposeAll /Users/alice/private-project",
          reason: "reload because token-secret was present",
        },
        request: {
          method: "POST",
          path: "/global/dispose?cwd=/Users/alice/private-project&token=secret",
          source: "renderer",
          directory_key: "dir:safehashed",
          workspace_id: "workspace-secret",
          client_action: {
            id: "client-action-secret",
            kind: "global.dispose.secret",
            route_session_id: "ses_route_secret",
            visible_session_id: "ses_visible_secret",
          },
        },
      },
    }

    const fakeSnapshot: Export.Snapshot = {
      schema_version: 1,
      format: "pawwork-session-export",
      exported_at: 1,
      root_session_id: SessionID.make("ses_lifecycle_sensitive"),
      runtime_context: {
        app_version: "test",
        runtime_namespace: "pawwork",
        platform: process.platform,
        os_version: "test",
        locale: "en-US",
        timezone: "UTC",
        instruction_sources: [],
        model_refs: {},
        stats: { session_count: 1, message_count: 1, part_count: 0, omitted_attachment_count: 0 },
      },
      diagnostics: { run_lifecycle_schema_version: 1, run_lifecycle: [lifecycleEvent] },
      session: {
        info: {
          id: SessionID.make("ses_lifecycle_sensitive"),
          version: "0.0.0",
          time: { created: 1, updated: 1 },
          title: "x",
          directory: "/tmp/project",
        } as SessionNs.Info,
        had_cloud_share: false,
        diffs: [],
        messages: [
          {
            info: {
              id: MessageID.make("msg_lifecycle_sensitive"),
              role: "user",
              sessionID: SessionID.make("ses_lifecycle_sensitive"),
              time: { created: 1 },
              agent: "build",
              model: { providerID: "test", modelID: "model" },
              diagnostics: { run_lifecycle: [lifecycleEvent] },
            } as MessageV2.User,
            parts: [],
          },
        ],
        children: [],
      },
    }

    const sanitized = Export.sanitizeSnapshot(fakeSnapshot)
    const serialized = JSON.stringify(sanitized)
    expect(serialized).not.toContain("/Users/alice")
    expect(serialized).not.toContain("token-secret")
    expect(serialized).not.toContain("workspace-secret")
    expect(serialized).not.toContain("client-action-secret")
    expect(serialized).not.toContain("ses_route_secret")
    expect(serialized).not.toContain("ses_visible_secret")
    expect(sanitized.diagnostics.run_lifecycle?.[0]?.lifecycle?.affected_directory_keys).toEqual(["dir:safehashed"])
    expect(sanitized.diagnostics.run_lifecycle?.[0]?.lifecycle?.origin?.source).toBe("server_handler")
    expect(sanitized.diagnostics.run_lifecycle?.[0]?.lifecycle?.request?.method).toBe("POST")
    expect(
      sanitized.session.messages[0].info.role === "user"
        ? sanitized.session.messages[0].info.diagnostics?.run_lifecycle?.[0]?.lifecycle?.request?.directory_key
        : undefined,
    ).toBe("dir:safehashed")
  })

  test("sanitizeSnapshot preserves safe run observability error fingerprints", () => {
    const summary: RunObservability.Summary = {
      schema_version: 1,
      run_id: RunObservability.RunID.make("run_sanitize"),
      trace_id: MessageID.make("msg_sanitize"),
      session_id: SessionID.make("ses_sanitize"),
      message_id: MessageID.make("msg_sanitize"),
      provider: "test",
      model: "test-model",
      created_at: 1,
      completed_at: 2,
      classification: "external_stream_disconnect",
      summary_key: RunObservability.summaryKeyFor("external_stream_disconnect", "provider_progress_socket_closed"),
      retry_safety: {
        recommendation: "candidate_safe_auto_retry",
        confidence: "medium",
        reason: "no_visible_output_or_tool_execution",
        safety_scope: "user_visible_and_tool_side_effects",
      },
      attempts: [],
      provider_progress_seen: true,
      visible_output_seen: false,
      tool_call_seen: false,
      tool_input_started: false,
      tool_input_completed: false,
      tool_call_materialized: false,
      tool_execution_started: false,
      read_only_tool_started: false,
      unsafe_side_effect_started: false,
      unsafe_side_effect_kinds: [],
      side_effect_facts_complete: true,
      durations_ms: { total: 1 },
      error: { name: "TypeError", message: "terminated", cause_code: "UND_ERR_SOCKET" },
    }
    const fakeSnapshot: Export.Snapshot = {
      schema_version: 1,
      format: "pawwork-session-export",
      exported_at: 1,
      root_session_id: SessionID.make("ses_sanitize"),
      runtime_context: {
        app_version: "test",
        runtime_namespace: "pawwork",
        platform: process.platform,
        os_version: "test",
        locale: "en-US",
        timezone: "UTC",
        instruction_sources: [],
        model_refs: {},
        stats: { session_count: 1, message_count: 1, part_count: 0, omitted_attachment_count: 0 },
      },
      diagnostics: { run_observability_schema_version: 1, run_observability: [summary] },
      session: {
        info: {
          id: SessionID.make("ses_sanitize"),
          version: "0.0.0",
          time: { created: 1, updated: 1 },
          title: "x",
          directory: "/tmp/project",
        } as SessionNs.Info,
        had_cloud_share: false,
        diffs: [],
        messages: [
          {
            info: {
              id: MessageID.make("msg_sanitize"),
              role: "assistant",
              sessionID: SessionID.make("ses_sanitize"),
              parentID: MessageID.make("msg_parent_sanitize"),
              mode: "build",
              agent: "build",
              path: { cwd: "/tmp/project", root: "/tmp/project" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: "test-model",
              providerID: "test",
              time: { created: 1 },
              diagnostics: { run_observability: summary },
            } as MessageV2.Assistant,
            parts: [],
          },
        ],
        children: [],
      },
    }

    const sanitized = Export.sanitizeSnapshot(fakeSnapshot)
    expect(sanitized.diagnostics.run_observability?.[0]?.error?.cause_code).toBe("UND_ERR_SOCKET")
    expect(
      sanitized.session.messages[0].info.role === "assistant"
        ? sanitized.session.messages[0].info.diagnostics?.run_observability?.error?.cause_code
        : undefined,
    ).toBe("UND_ERR_SOCKET")
    expect(JSON.stringify(sanitized)).not.toContain("/Users/")
    expect(JSON.stringify(sanitized)).not.toContain("sk-")
  })

  test("exports sanitized run incidents as authoritative diagnostics", () => {
    const incident = {
      schema_version: 1,
      incident_id: "incident:msg_sanitize",
      run_id: RunObservability.RunID.make("run_sanitize_incident"),
      trace_id: MessageID.make("msg_sanitize_incident"),
      session_id: SessionID.make("ses_sanitize_incident"),
      message_id: MessageID.make("msg_sanitize_incident"),
      created_at: 1,
      completed_at: 2,
      terminal_cause: {
        category: "provider_transport_disconnect",
        subcategory: "during_tool_input_generation",
        boundary: "sdk_transport",
        confidence: "high",
        error: { name: "TypeError", message: "terminated", cause_code: "UND_ERR_SOCKET" },
      },
      phase: {
        run_phase: "tool_generation",
        stream_phase: "tool_input_generation",
        tool_phase: "tool_input_started",
      },
      facts: {
        provider_progress_seen: true,
        visible_output_seen: true,
        text_output_started: true,
        reasoning_output_started: false,
        tool_input_started: true,
        tool_input_completed: false,
        tool_call_materialized: false,
        tool_execution_started: false,
        tool_execution_completed: false,
        read_only_tool_started: false,
        unsafe_side_effect_started: false,
        unsafe_side_effect_kinds: [],
        side_effect_facts_complete: true,
        lifecycle_close_seen: true,
        user_cancel_seen: false,
        watchdog_fired: false,
        pending_tool_parts_interrupted: 1,
      },
      provenance: { completeness: "partial" },
      recovery: {
        recommendation: "offer_continue",
        confidence: "high",
        reason: "partial_tool_input_without_execution",
        safety_scope: "visible_output_and_tool_side_effects",
      },
      evidence: [
        {
          event_id: "incident:msg_sanitize:evidence:1",
          order: 1,
          monotonic_ms: 100,
          source: "provider_stream",
          event_type: "provider_transport_failure",
          terminal_candidate: true,
          confidence: "high",
          error: { message: "terminated", cause_code: "UND_ERR_SOCKET" },
        },
        {
          event_id: "incident:msg_sanitize:evidence:2",
          order: 2,
          monotonic_ms: 110,
          source: "processor",
          event_type: "pending_tool_part_interrupted",
          terminal_candidate: false,
          confidence: "medium",
          redactions: ["raw_tool_input", "/Users/secret/project", "sk-private"],
          interruption_phase: "tool_input_generation",
          tool_execution_started: false,
        },
      ],
      user_summary: {
        title_key: "run_incident.provider_transport_disconnect",
        body_key: "run_incident.provider_transport_disconnect.during_tool_input_generation",
        severity: "warning",
      },
      plain_summary: "The provider stream disconnected while PawWork was preparing a tool call. The tool did not run.",
      diagnostics_complete: true,
    }
    const summary = {
      schema_version: 1,
      run_id: RunObservability.RunID.make("run_sanitize_incident"),
      trace_id: MessageID.make("msg_sanitize_incident"),
      session_id: SessionID.make("ses_sanitize_incident"),
      message_id: MessageID.make("msg_sanitize_incident"),
      provider: "test",
      model: "test-model",
      created_at: 1,
      classification: "tool_failure",
      summary_key: RunObservability.summaryKeyFor("tool_failure", "tool_execution_failed"),
      retry_safety: {
        recommendation: "unknown",
        confidence: "low",
        reason: "unknown",
        safety_scope: "user_visible_and_tool_side_effects",
      },
      attempts: [],
      provider_progress_seen: true,
      visible_output_seen: true,
      tool_call_seen: false,
      tool_input_started: true,
      tool_input_completed: false,
      tool_call_materialized: false,
      tool_execution_started: false,
      read_only_tool_started: false,
      unsafe_side_effect_started: false,
      unsafe_side_effect_kinds: [],
      side_effect_facts_complete: true,
      durations_ms: {},
      incident,
    } as RunObservability.Summary
    const sanitized = Export.sanitizeSnapshot({
      schema_version: 1,
      format: "pawwork-session-export",
      exported_at: 1,
      root_session_id: SessionID.make("ses_sanitize_incident"),
      runtime_context: {
        app_version: "test",
        runtime_namespace: "pawwork",
        platform: process.platform,
        os_version: "test",
        locale: "en-US",
        timezone: "UTC",
        instruction_sources: [],
        model_refs: {},
        stats: { session_count: 1, message_count: 1, part_count: 0, omitted_attachment_count: 0 },
      },
      diagnostics: { run_observability_schema_version: 1, run_observability: [summary] },
      session: {
        info: {
          id: SessionID.make("ses_sanitize_incident"),
          version: "0.0.0",
          time: { created: 1, updated: 1 },
          title: "x",
          directory: "/tmp/project",
        } as SessionNs.Info,
        had_cloud_share: false,
        diffs: [],
        messages: [],
        children: [],
      },
    })

    expect(sanitized.diagnostics.run_incident_schema_version).toBe(1)
    expect(sanitized.diagnostics.run_incidents?.[0]?.terminal_cause.category).toBe("provider_transport_disconnect")
    expect(sanitized.diagnostics.incident_chains?.[0]).toMatchObject({
      incident_id: "incident:msg_sanitize",
      run_id: RunObservability.RunID.make("run_sanitize_incident"),
      session_id: SessionID.make("ses_sanitize_incident"),
      message_id: MessageID.make("msg_sanitize_incident"),
      terminal_cause_category: "provider_transport_disconnect",
      run_phase: "tool_generation",
      recovery_recommendation: "offer_continue",
      diagnostics_complete: true,
    })
    expect(sanitized.diagnostics.run_incidents?.[0]?.evidence?.map((event) => event.event_type)).toEqual([
      "provider_transport_failure",
      "pending_tool_part_interrupted",
    ])
    const serialized = JSON.stringify(sanitized.diagnostics.run_incidents)
    expect(serialized).toContain("tool_input_generation")
    expect(serialized).toContain("tool_execution_started")
    expect(serialized).toContain("raw_tool_input")
    expect(serialized).not.toContain("/Users/secret")
    expect(serialized).not.toContain("sk-private")
  })

  test("sanitizes precomputed incident chains in snapshots", () => {
    const sanitized = Export.sanitizeSnapshot({
      schema_version: 1,
      format: "pawwork-session-export",
      exported_at: 1,
      root_session_id: SessionID.make("ses_chain_sanitize"),
      runtime_context: {
        app_version: "test",
        runtime_namespace: "pawwork",
        platform: process.platform,
        os_version: "test",
        locale: "en-US",
        timezone: "UTC",
        instruction_sources: [],
        model_refs: {},
        stats: { session_count: 1, message_count: 0, part_count: 0, omitted_attachment_count: 0 },
      },
      diagnostics: {
        incident_chains: [
          {
            incident_id: "incident:chain_sanitize",
            run_id: RunObservability.RunID.make("run_chain_sanitize"),
            session_id: SessionID.make("ses_chain_sanitize"),
            message_id: MessageID.make("msg_chain_sanitize"),
            terminal_cause_category: "local_lifecycle_close",
            run_phase: "unknown",
            recovery_recommendation: "do_not_retry",
            nearest_origin: {
              source: "server_handler",
              operation: "/Users/alice/project/private-route",
              reason: "sk-secret",
            },
            nearest_request: {
              method: "POST",
              path: "/Users/alice/project",
              source: "renderer",
              directory_key: "dir:safe",
              workspace_id: "workspace/secret",
              client_action: {
                id: "client-action sk-secret",
                kind: "/Users/alice/project sk-secret",
              },
            },
            diagnostics_complete: false,
            plain_summary: "secret path /Users/alice/project and token sk-secret",
          },
        ],
      },
      session: {
        info: {
          id: SessionID.make("ses_chain_sanitize"),
          version: "0.0.0",
          time: { created: 1, updated: 1 },
          title: "x",
          directory: "/tmp/project",
        } as SessionNs.Info,
        had_cloud_share: false,
        diffs: [],
        messages: [],
        children: [],
      },
    })

    const serialized = JSON.stringify(sanitized.diagnostics.incident_chains)
    expect(serialized).toContain("[redacted:incident-chain-summary:incident:chain_sanitize]")
    expect(serialized).toContain("incident-chain-origin-operation")
    expect(serialized).toContain("unknown")
    expect(serialized).not.toContain("/Users/alice")
    expect(serialized).not.toContain("sk-secret")
  })

  test("exports sanitized side-effect boundary snapshots without raw request data", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_side_effect_snapshot_sanitize"),
      traceID: MessageID.make("msg_side_effect_snapshot_sanitize"),
      sessionID: SessionID.make("ses_side_effect_snapshot_sanitize"),
      messageID: MessageID.make("msg_side_effect_snapshot_sanitize"),
      providerID: "test",
      modelID: "test-model",
      createdAt: 1,
      monotonicStartMs: 100,
    })
    const attempt = recorder.beginAttempt({ attemptIndex: 1, at: 2, monotonicMs: 110 })
    recorder.recordSideEffectBoundarySnapshot({
      attemptID: attempt.attemptID,
      at: 3,
      monotonicMs: 120,
      snapshot: {
        exposed_tool_count: 1,
        unknown_tool_count: 1,
        unclassified_effect_count: 1,
        provider_executed_capability_present: false,
        external_boundary_present: false,
        proof_result: "incomplete",
        proof_reason: "unknown_tool_boundary",
      },
    })
    recorder.recordAttemptFailureAndDeriveRecovery({
      attemptID: attempt.attemptID,
      at: 4,
      monotonicMs: 130,
      error: new Error("raw provider body with /Users/alice/project and sk-secret"),
      evidence: ["iterator_error"],
    })
    const summary = recorder.finalize({ completedAt: 5, monotonicMs: 140 })

    const sanitized = Export.sanitizeSnapshot({
      schema_version: 1,
      format: "pawwork-session-export",
      exported_at: 1,
      root_session_id: SessionID.make("ses_side_effect_snapshot_sanitize"),
      runtime_context: {
        app_version: "test",
        runtime_namespace: "pawwork",
        platform: process.platform,
        os_version: "test",
        locale: "en-US",
        timezone: "UTC",
        instruction_sources: [],
        model_refs: {},
        stats: { session_count: 1, message_count: 0, part_count: 0, omitted_attachment_count: 0 },
      },
      diagnostics: { run_observability_schema_version: 1, run_observability: [summary] },
      session: {
        info: {
          id: SessionID.make("ses_side_effect_snapshot_sanitize"),
          version: "0.0.0",
          time: { created: 1, updated: 1 },
          title: "x",
          directory: "/tmp/project",
        } as SessionNs.Info,
        had_cloud_share: false,
        diffs: [],
        messages: [],
        children: [],
      },
    })

    expect(sanitized.diagnostics.run_observability?.[0]?.side_effect_boundary_snapshot).toMatchObject({
      exposed_tool_count: 1,
      unknown_tool_count: 1,
      unclassified_effect_count: 1,
      proof_result: "incomplete",
      proof_reason: "unknown_tool_boundary",
    })
    expect(
      sanitized.diagnostics.run_incidents?.[0]?.evidence?.find(
        (event) => event.event_type === "side_effect_boundary_snapshot",
      )?.side_effect_boundary_snapshot,
    ).toMatchObject({
      proof_result: "incomplete",
      proof_reason: "unknown_tool_boundary",
    })
    const serialized = JSON.stringify(sanitized.diagnostics)
    expect(serialized).toContain("unknown_tool_boundary")
    expect(serialized).not.toContain("/Users/alice")
    expect(serialized).not.toContain("sk-secret")
    expect(serialized).not.toContain("raw provider body")
  })

  test("exports recovered stream incidents without making final run observability terminal", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_recovered_incident_export"),
      traceID: MessageID.make("msg_recovered_incident_export"),
      sessionID: SessionID.make("ses_recovered_incident_export"),
      messageID: MessageID.make("msg_recovered_incident_export"),
      providerID: "test",
      modelID: "test-model",
      createdAt: 1,
      monotonicStartMs: 100,
    })
    const first = recorder.beginAttempt({ attemptIndex: 1, at: 2, monotonicMs: 110 })
    recorder.recordAttemptFailureAndDeriveRecovery({
      attemptID: first.attemptID,
      at: 3,
      monotonicMs: 120,
      error: new Error("LLM stream connection timed out after 120000ms without provider progress"),
      evidence: ["watchdog_fired", "iterator_error"],
      watchdog: { phase: "connect" },
    })
    recorder.recordRecoveryDecision({
      attemptID: first.attemptID,
      at: 4,
      monotonicMs: 125,
      technical_retryable: true,
      safety_gate_decision: {
        recommendation: "auto_retry",
        confidence: "high",
        reason: "no_visible_output_or_tool_execution",
        safety_scope: "visible_output_and_tool_side_effects",
      },
      recovery_mode: "replay",
      attempt_kind: "safe_recovery_replay",
      model_stream_attempt: 1,
      safe_recovery_attempt: 0,
      timeout_policy: "reasoning_first_attempt",
      presentation: "recovery",
    })
    recorder.recordAutoRetryAttempted({ attemptID: first.attemptID, at: 4, monotonicMs: 130 })
    const second = recorder.beginAttempt({ attemptIndex: 2, at: 5, monotonicMs: 140 })
    recorder.recordVisibleOutput({ attemptID: second.attemptID, at: 6, monotonicMs: 150 })
    const summary = recorder.finalize({ completedAt: 7, monotonicMs: 160 })

    const sanitized = Export.sanitizeSnapshot({
      schema_version: 1,
      format: "pawwork-session-export",
      exported_at: 1,
      root_session_id: SessionID.make("ses_recovered_incident_export"),
      runtime_context: {
        app_version: "test",
        runtime_namespace: "pawwork",
        platform: process.platform,
        os_version: "test",
        locale: "en-US",
        timezone: "UTC",
        instruction_sources: [],
        model_refs: {},
        stats: { session_count: 1, message_count: 0, part_count: 0, omitted_attachment_count: 0 },
      },
      diagnostics: { run_observability_schema_version: 1, run_observability: [summary] },
      session: {
        info: {
          id: SessionID.make("ses_recovered_incident_export"),
          version: "0.0.0",
          time: { created: 1, updated: 1 },
          title: "x",
          directory: "/tmp/project",
        } as SessionNs.Info,
        had_cloud_share: false,
        diffs: [],
        messages: [],
        children: [],
      },
    })

    expect(sanitized.diagnostics.run_observability?.[0]?.classification).toBe("success")
    expect(sanitized.diagnostics.run_observability?.[0]?.incident).toBeUndefined()
    expect(sanitized.diagnostics.run_observability?.[0]?.recovered_incidents?.[0]?.terminal_cause).toMatchObject({
      category: "watchdog_timeout",
      subcategory: "connect",
    })
    expect(sanitized.diagnostics.run_observability?.[0]?.recovery_decision).toMatchObject({
      technical_retryable: true,
      safety_gate_recommendation: "auto_retry",
      recovery_mode: "replay",
      attempt_kind: "safe_recovery_replay",
      timeout_policy: "reasoning_first_attempt",
      presentation: "recovery",
      retry_attempted: true,
      outcome: "recovered",
    })
    expect(sanitized.diagnostics.run_incidents?.[0]?.terminal_cause).toMatchObject({
      category: "watchdog_timeout",
      subcategory: "connect",
    })
  })

  test("sanitizes generated lifecycle incident provenance and chains", () => {
    const recorder = RunObservability.createRecorder({
      runID: RunObservability.RunID.make("run_generated_chain_sanitize"),
      traceID: MessageID.make("msg_generated_chain_sanitize"),
      sessionID: SessionID.make("ses_generated_chain_sanitize"),
      messageID: MessageID.make("msg_generated_chain_sanitize"),
      providerID: "test",
      modelID: "test-model",
      createdAt: 1,
      monotonicStartMs: 100,
    })
    recorder.recordScopeClosed({
      at: 2,
      monotonicMs: 120,
      lifecycleActionID: "lifecycle:instance_reload:unsafe_request",
      lifecycleKind: "instance_reload",
      lifecycleAffectedDirectoryKeys: ["dir:safe"],
      lifecycleOrigin: {
        source: "server_handler",
        operation: "instance.reload",
        reason: "/Users/alice/project sk-secret",
      },
      lifecycleRequest: {
        method: "POST",
        path: "/project/git/init",
        source: "renderer",
        directory_key: "dir:safe",
        client_action: {
          id: "client-action-unsafe",
          kind: "/Users/alice/project sk-secret",
        },
      },
    })
    const summary = recorder.finalize({ completedAt: 3, monotonicMs: 130 })

    const sanitized = Export.sanitizeSnapshot({
      schema_version: 1,
      format: "pawwork-session-export",
      exported_at: 1,
      root_session_id: SessionID.make("ses_generated_chain_sanitize"),
      runtime_context: {
        app_version: "test",
        runtime_namespace: "pawwork",
        platform: process.platform,
        os_version: "test",
        locale: "en-US",
        timezone: "UTC",
        instruction_sources: [],
        model_refs: {},
        stats: { session_count: 1, message_count: 0, part_count: 0, omitted_attachment_count: 0 },
      },
      diagnostics: { run_observability_schema_version: 1, run_observability: [summary] },
      session: {
        info: {
          id: SessionID.make("ses_generated_chain_sanitize"),
          version: "0.0.0",
          time: { created: 1, updated: 1 },
          title: "x",
          directory: "/tmp/project",
        } as SessionNs.Info,
        had_cloud_share: false,
        diffs: [],
        messages: [],
        children: [],
      },
    })

    const serialized = JSON.stringify({
      run_incidents: sanitized.diagnostics.run_incidents,
      incident_chains: sanitized.diagnostics.incident_chains,
    })
    expect(serialized).toContain("unknown")
    expect(serialized).not.toContain("/Users/alice")
    expect(serialized).not.toContain("sk-secret")
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
