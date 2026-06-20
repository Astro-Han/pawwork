import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Process } from "../../src/util/process"
import { tmpdir } from "../fixture/fixture"
import { withEmbeddedServerArtifactLock } from "../shared/embedded-server-artifact-lock"
import { expectModelsSnapshotUnchanged, writeCurrentModelsFixture } from "./models-snapshot-fixture"

const root = path.join(import.meta.dir, "../..")
const distEntry = path.join(root, "dist", "node", "node.js")

describe("built node opencli adapters", () => {
  test("loads bundled adapter manifest and clis from the built embedded server artifact", async () => {
    await withEmbeddedServerArtifactLock(async () => {
      await using tmp = await tmpdir()
      const modelsFixture = writeCurrentModelsFixture(root, tmp.path)
      const runtimeRoot = path.join(tmp.path, "runtime")
      const runtimeHome = path.join(runtimeRoot, "home")
      const isolatedEnv = {
        ...process.env,
        MODELS_DEV_API_JSON: modelsFixture.fixture,
        HOME: runtimeHome,
        USERPROFILE: runtimeHome,
        XDG_DATA_HOME: path.join(runtimeRoot, "share"),
        XDG_CACHE_HOME: path.join(runtimeRoot, "cache"),
        XDG_CONFIG_HOME: path.join(runtimeRoot, "config"),
        XDG_STATE_HOME: path.join(runtimeRoot, "state"),
        OPENCODE_TEST_HOME: runtimeHome,
        OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(runtimeRoot, "managed"),
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
        OPENCODE_DB: ":memory:",
        OPENCODE_CLIENT: "desktop",
      }

      await Promise.all(
        [
          isolatedEnv.HOME,
          isolatedEnv.XDG_DATA_HOME,
          isolatedEnv.XDG_CACHE_HOME,
          isolatedEnv.XDG_CONFIG_HOME,
          isolatedEnv.XDG_STATE_HOME,
          isolatedEnv.OPENCODE_TEST_MANAGED_CONFIG_DIR,
        ].map((dir) => fs.mkdir(dir, { recursive: true })),
      )

      await Process.run([process.execPath, "run", "build:embedded-server"], {
        cwd: root,
        env: isolatedEnv,
      })
      expectModelsSnapshotUnchanged(modelsFixture)

      const script = `
        import { Effect, ManagedRuntime } from "effect"
        import { Instance, Log, ToolRegistry } from ${JSON.stringify(pathToFileURL(distEntry).href)}

        const directory = process.env.TEST_DIRECTORY
        if (!directory) throw new Error("missing TEST_DIRECTORY")

        await Log.init({ level: "DEBUG", print: false })
        const registryRuntime = ManagedRuntime.make(ToolRegistry.defaultLayer)
        const registryTools = (input) =>
          registryRuntime.runPromise(ToolRegistry.Service.use((registry) => registry.tools(input)))
        let exitCode = 0
        try {
          const result = await Instance.provide({
            directory,
            fn: async () => {
              const tools = await registryTools({
                providerID: "openai",
                modelID: "gpt-5",
                agent: { name: "build", mode: "primary", permission: [], options: {} },
                activatedTools: new Set(["opencli_search", "opencli_run"]),
              })
              const search = tools.find((tool) => tool.id === "opencli_search")
              if (!search) throw new Error("opencli_search was not activated from the built registry")
              const ctx = {
                sessionID: "ses_built_opencli",
                messageID: "msg_built_opencli",
                agent: "build",
                abort: AbortSignal.any([]),
                messages: [],
                metadata: () => Effect.void,
                ask: () => Effect.void,
              }
              const account = await Effect.runPromise(search.execute({ query: "12306 account", limit: 5 }, ctx))
              const xiaohongshu = await Effect.runPromise(search.execute({ query: "xiaohongshu ask", limit: 5 }, ctx))
              return { account, xiaohongshu }
            }
          })
          console.log(JSON.stringify({
            account: { title: result.account.title, output: result.account.output, metadata: result.account.metadata },
            xiaohongshu: {
              title: result.xiaohongshu.title,
              output: result.xiaohongshu.output,
              metadata: result.xiaohongshu.metadata,
            },
          }))
        } catch (error) {
          console.error(error instanceof Error ? error.stack : String(error))
          exitCode = 1
        } finally {
          await Instance.disposeAll()
          await registryRuntime.dispose()
        }

        await new Promise((resolve) => setTimeout(resolve, 50))
        process.exit(exitCode)
      `

      const result = await Process.run(["node", "--input-type=module", "-e", script], {
        cwd: root,
        env: {
          ...isolatedEnv,
          TEST_DIRECTORY: tmp.path,
        },
      })
      const output = JSON.parse(result.stdout.toString("utf8"))
      expect(output.account.title).toBe('OpenCLI commands for "12306 account"')
      expect(output.account.output).toContain('<opencli_command name="12306/me">')
      expect(output.account.output).not.toContain("instagram/reel")
      expect(output.account.metadata.count).toBeGreaterThan(0)
      expect(output.xiaohongshu.title).toBe('OpenCLI commands for "xiaohongshu ask"')
      expect(output.xiaohongshu.output).toContain('<opencli_command name="xiaohongshu/ask">')
      expect(output.xiaohongshu.output).toContain("Ask 小红书点点")
    })
  })
})
