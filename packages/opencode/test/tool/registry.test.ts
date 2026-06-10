import { afterEach, describe, expect, spyOn, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { fileURLToPath } from "url"
import { Effect } from "effect"
import { tmpdir } from "../fixture/fixture"
import { writeInstalledConfigDeps, writeMockConfigInstall } from "../shared/mock-npm-install"
import { withConfigDepsLock } from "../shared/config-deps-lock"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { ProviderTransform } from "../../src/provider"
import { localToolImportSpec, ToolRegistry } from "../../src/tool/registry"
import { Settings } from "../../src/settings"
import { MessageID, SessionID } from "../../src/session/schema"
import type { MessageV2 } from "../../src/session/message-v2"
import { LLM } from "../../src/session/llm"
import * as EffectZod from "../../src/util/effect-zod"
import { Npm } from "@opencode-ai/core/npm"

afterEach(async () => {
  await Instance.disposeAll()
})

async function withMockedConfigInstall<T>(fn: () => Promise<T>): Promise<T> {
  return await withConfigDepsLock(async () => {
    const install = spyOn(Npm, "install").mockImplementation((dir: string) => writeMockConfigInstall(dir))
    try {
      return await fn()
    } finally {
      install.mockRestore()
    }
  })
}

describe("tool.registry", () => {
  test("does not expose built-in trash tool", async () => {
    await using tmp = await tmpdir()

    await withMockedConfigInstall(async () => {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const ids = await ToolRegistry.ids()
          expect(ids).not.toContain("trash")
        },
      })
    })
  })

  test("keeps automate on the default model surface", async () => {
    await using tmp = await tmpdir()

    await withMockedConfigInstall(async () => {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const ids = await ToolRegistry.ids()
          expect(ids).toContain("automate")

          const tools = await ToolRegistry.tools({
            providerID: ProviderID.make("openai"),
            modelID: ModelID.make("gpt-5"),
            agent: { name: "build", mode: "primary", permission: [], options: {} },
          })
          const surface = tools.map((tool) => tool.id)
          expect(surface).toContain("automate")
          const card = tools.find((tool) => tool.id === "tool_info")!.description
          expect(card).not.toContain("automate")
        },
      })
    })
  })

  test("keeps trash removal contract across prompt and package surfaces", async () => {
    const shellDescription = await Bun.file(new URL("../../src/tool/shell.txt", import.meta.url)).text()
    expect(shellDescription).not.toContain("trash tool")
    expect(shellDescription).toContain("Avoid permanent deletion commands")
    expect(shellDescription).toContain("gio trash")
    expect(shellDescription).toContain("trash-put")
    expect(shellDescription).toContain("Get-Command")

    const packageJson = (await Bun.file(new URL("../../package.json", import.meta.url)).json()) as {
      dependencies?: Record<string, string>
    }
    expect(Object.hasOwn(packageJson.dependencies ?? {}, "trash")).toBe(false)

    const lockfile = await Bun.file(new URL("../../../../bun.lock", import.meta.url)).text()
    const opencodeWorkspaceHeader = '    "packages/opencode": {'
    const opencodeWorkspaceStart = lockfile.indexOf(opencodeWorkspaceHeader)
    expect(opencodeWorkspaceStart).toBeGreaterThanOrEqual(0)
    const afterOpencodeWorkspaceHeader = lockfile.slice(opencodeWorkspaceStart + opencodeWorkspaceHeader.length)
    const nextWorkspaceOffset = afterOpencodeWorkspaceHeader.search(/\n    "[^"]+": \{/)
    const opencodeWorkspaceEnd =
      nextWorkspaceOffset === -1
        ? lockfile.length
        : opencodeWorkspaceStart + opencodeWorkspaceHeader.length + nextWorkspaceOffset
    const opencodeWorkspaceLockfileSection = lockfile.slice(opencodeWorkspaceStart, opencodeWorkspaceEnd)
    expect(opencodeWorkspaceLockfileSection).not.toContain('"trash": "10"')
    expect(opencodeWorkspaceLockfileSection).not.toContain('"trash": ["trash@')
  })

  test("loads tools from .opencode/tool (singular)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const opencodeDir = path.join(dir, ".opencode")
        await fs.mkdir(opencodeDir, { recursive: true })

        const toolDir = path.join(opencodeDir, "tool")
        await fs.mkdir(toolDir, { recursive: true })

        await Bun.write(
          path.join(toolDir, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    await withMockedConfigInstall(async () => {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const ids = await ToolRegistry.ids()
          expect(ids).toContain("hello")
        },
      })
    })
  })

  test("loads tools from .opencode/tools (plural)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const opencodeDir = path.join(dir, ".opencode")
        await fs.mkdir(opencodeDir, { recursive: true })

        const toolsDir = path.join(opencodeDir, "tools")
        await fs.mkdir(toolsDir, { recursive: true })

        await Bun.write(
          path.join(toolsDir, "hello.ts"),
          [
            "export default {",
            "  description: 'hello tool',",
            "  args: {},",
            "  execute: async () => {",
            "    return 'hello world'",
            "  },",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    await withMockedConfigInstall(async () => {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const ids = await ToolRegistry.ids()
          expect(ids).toContain("hello")
        },
      })
    })
  })

  test("ignores non-tool exports in .opencode/tool files (7a012cac08)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const toolDir = path.join(dir, ".opencode", "tool")
        await fs.mkdir(toolDir, { recursive: true })

        await Bun.write(
          path.join(toolDir, "mixed.ts"),
          [
            "export const helper = 'not a tool'",
            "export default {",
            "  description: 'mixed tool',",
            "  args: {},",
            "  execute: async () => 'ok',",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    await withMockedConfigInstall(async () => {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const ids = await ToolRegistry.ids()
          // The valid default export still loads.
          expect(ids).toContain("mixed")
          // The non-tool string export must not be wrapped into a phantom tool —
          // it has no `args`/`description`/`execute`, so `fromPlugin` would build a
          // bogus, description-less tool keyed `mixed_helper`.
          expect(ids).not.toContain("mixed_helper")
        },
      })
    })
  })

  test("honors a per-tool disable for a mixed-export local tool file (7a012cac08)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const opencodeDir = path.join(dir, ".opencode")
        await fs.mkdir(opencodeDir, { recursive: true })

        const toolDir = path.join(opencodeDir, "tool")
        await fs.mkdir(toolDir, { recursive: true })

        await Bun.write(
          path.join(opencodeDir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            tools: { mixed: false },
          }),
        )

        // A non-tool sibling export keeps the coarse pre-import `ids.every(disabled)`
        // skip from firing (mixed_helper is not disabled), so the file is imported.
        // The disabled real tool must still not register.
        await Bun.write(
          path.join(toolDir, "mixed.ts"),
          [
            "export const helper = 'not a tool'",
            "export default {",
            "  description: 'mixed tool',",
            "  args: {},",
            "  execute: async () => 'ok',",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    await withMockedConfigInstall(async () => {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const ids = await ToolRegistry.ids()
          expect(ids).not.toContain("mixed")
          expect(ids).not.toContain("mixed_helper")
        },
      })
    })
  })

  test("bridges plugin ctx.ask and ctx.metadata so the framework Effects actually run", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const toolDir = path.join(dir, ".opencode", "tool")
        await fs.mkdir(toolDir, { recursive: true })
        await Bun.write(
          path.join(toolDir, "asker.ts"),
          [
            "export default {",
            "  description: 'asks for permission and sets metadata then resolves',",
            "  args: {},",
            "  execute: async (_args: unknown, ctx: any) => {",
            "    await ctx.ask({ permission: 'asker', patterns: [], always: [], metadata: {} })",
            "    ctx.metadata({ title: 'asked', metadata: { ok: true } })",
            "    return 'asked'",
            "  },",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    await withMockedConfigInstall(async () => {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tools = await ToolRegistry.tools({
            providerID: ProviderID.make("openai"),
            modelID: ModelID.make("gpt-5"),
            agent: { name: "build", mode: "primary", permission: [], options: {} },
          })
          const asker = tools.find((tool) => tool.id === "asker")
          expect(asker).toBeDefined()

          // The framework `ask`/`metadata` are Effects. Plugin tools call them as a
          // Promise (`await ctx.ask`) and `void` (`ctx.metadata`); without the
          // EffectBridge the `...toolCtx` spread hands over the raw Effect and it is
          // never executed — both silent no-ops. Counting runs proves the bridge runs
          // them: `ask` is awaited, `metadata` is fire-and-forget.
          let askRuns = 0
          let metadataRuns = 0
          const ctx = {
            sessionID: SessionID.descending(),
            messageID: MessageID.ascending(),
            agent: "build",
            abort: new AbortController().signal,
            messages: [],
            metadata: () =>
              Effect.sync(() => {
                metadataRuns++
              }),
            ask: () =>
              Effect.sync(() => {
                askRuns++
              }),
            extra: {},
          }

          const result = await Effect.runPromise(asker!.execute({}, ctx))
          // `metadata` is fire-and-forget; flush pending microtasks before asserting.
          await new Promise((resolve) => setTimeout(resolve, 10))
          expect(askRuns).toBe(1)
          expect(metadataRuns).toBe(1)
          expect(result.output).toBe("asked")
        },
      })
    })
  })

  test("local tool import spec normalizes filesystem paths to file URLs", () => {
    const toolPath = path.resolve("pawwork-tools", "marked.ts")
    expect(localToolImportSpec(toolPath)).toStartWith("file://")
    expect(localToolImportSpec(toolPath)).not.toBe(toolPath)
    expect(localToolImportSpec("C:\\Users\\test\\tool.ts")).toStartWith("file://")
    expect(localToolImportSpec("C:\\Users\\test\\tool.ts")).not.toBe("C:\\Users\\test\\tool.ts")
    expect(localToolImportSpec("file:///tmp/tool.ts")).toBe("file:///tmp/tool.ts")
  })

  test("preserves Zod arg descriptions from a config-scoped plugin with its own zod (#27770)", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const opencodeDir = path.join(dir, ".opencode")
        const toolsDir = path.join(opencodeDir, "tools")
        const plugin = path.join(opencodeDir, "node_modules", "@opencode-ai", "plugin")
        await fs.mkdir(path.join(plugin, "dist"), { recursive: true })
        await fs.mkdir(toolsDir, { recursive: true })

        // Copy the real zod into the config dir so the plugin's `import { z } from 'zod'`
        // resolves to a SEPARATE module instance with its own metadata registry — the
        // cross-module case opencode's z.toJSONSchema otherwise can't read. Pre-creating
        // both package.json files keeps `needsConfigDependencies` false, so no install
        // fires to clobber this shim.
        await fs.cp(path.dirname(fileURLToPath(import.meta.resolve("zod"))), path.join(opencodeDir, "node_modules", "zod"), {
          dereference: true,
          recursive: true,
        })

        await Bun.write(
          path.join(plugin, "package.json"),
          JSON.stringify({ name: "@opencode-ai/plugin", type: "module", exports: { ".": "./dist/index.js" } }),
        )
        // Older/manual plugin shim: returns the def as-is (no precomputed jsonSchema).
        await Bun.write(
          path.join(plugin, "dist", "index.js"),
          ["import { z } from 'zod'", "export function tool(input) {", "  return input", "}", "tool.schema = z", ""].join(
            "\n",
          ),
        )

        await Bun.write(
          path.join(toolsDir, "addition.ts"),
          [
            'import { tool } from "@opencode-ai/plugin"',
            "export default tool({",
            "  description: 'Use this tool to add two numbers and return their sum.',",
            "  args: {",
            "    left: tool.schema.number().describe('The first number to add'),",
            "    right: tool.schema.number().describe('The second number to add'),",
            "  },",
            "  execute: async (args: { left: number; right: number }) => `${args.left + args.right}`,",
            "})",
            "",
          ].join("\n"),
        )
      },
    })

    // Mock the auto-install (config.ts forks one on load) as a no-op so it can't
    // overwrite the pre-placed plugin shim + zod copy — writeMockConfigInstall would.
    await withConfigDepsLock(async () => {
      const install = spyOn(Npm, "install").mockImplementation(async () => {})
      try {
        await Instance.provide({
          directory: tmp.path,
          fn: async () => {
            const tools = await ToolRegistry.tools({
              providerID: ProviderID.make("openai"),
              modelID: ModelID.make("gpt-5"),
              agent: { name: "build", mode: "primary", permission: [], options: {} },
            })
            const addition = tools.find((tool) => tool.id === "addition")
            expect(addition).toBeDefined()

            // The arg descriptions live in the plugin's own zod registry; the metadata
            // walker in EffectZod.toJsonSchema must bridge them into the emitted schema.
            const schema = EffectZod.toJsonSchema(addition!.parameters) as {
              properties: Record<string, { type?: string; description?: string }>
            }
            expect(schema.properties.left).toMatchObject({ type: "number", description: "The first number to add" })
            expect(schema.properties.right).toMatchObject({ type: "number", description: "The second number to add" })
          },
        })
      } finally {
        install.mockRestore()
      }
    })
  })

  test("loads tools with external dependencies without crashing", async () => {
    await withMockedConfigInstall(async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const opencodeDir = path.join(dir, ".opencode")
          await fs.mkdir(opencodeDir, { recursive: true })

          const toolsDir = path.join(opencodeDir, "tools")
          await fs.mkdir(toolsDir, { recursive: true })

          await writeInstalledConfigDeps(opencodeDir, { cowsay: "^1.6.0" })

          await Bun.write(
            path.join(opencodeDir, "package-lock.json"),
            JSON.stringify({
              name: "custom-tools",
              lockfileVersion: 3,
              packages: {
                "": {
                  dependencies: {
                    "@opencode-ai/plugin": "*",
                    cowsay: "^1.6.0",
                  },
                },
              },
            }),
          )

          const cowsayDir = path.join(opencodeDir, "node_modules", "cowsay")
          await fs.mkdir(cowsayDir, { recursive: true })
          await Bun.write(
            path.join(cowsayDir, "package.json"),
            JSON.stringify({
              name: "cowsay",
              type: "module",
              exports: "./index.js",
            }),
          )
          await Bun.write(
            path.join(cowsayDir, "index.js"),
            ["export function say({ text }) {", "  return `moo ${text}`", "}", ""].join("\n"),
          )

          await Bun.write(
            path.join(toolsDir, "cowsay.ts"),
            [
              "import { say } from 'cowsay'",
              "export default {",
              "  description: 'tool that imports cowsay at top level',",
              "  args: { text: { type: 'string' } },",
              "  execute: async ({ text }: { text: string }) => {",
              "    return say({ text })",
              "  },",
              "}",
              "",
            ].join("\n"),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const ids = await ToolRegistry.ids()
          expect(ids).toContain("cowsay")
        },
      })
    })
  })

  test("waits for config-scoped dependencies before importing local tools with bare imports", async () => {
    await withConfigDepsLock(async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const toolsDir = path.join(dir, ".opencode", "tools")
          await fs.mkdir(toolsDir, { recursive: true })
          await Bun.write(
            path.join(dir, ".opencode", "package.json"),
            JSON.stringify({
              name: "custom-tools",
              dependencies: {
                "@opencode-ai/plugin": "*",
                "late-dep": "^1.0.0",
              },
            }),
          )

          await Bun.write(
            path.join(toolsDir, "late.ts"),
            [
              "import { ready } from 'late-dep'",
              "export default {",
              "  description: 'tool that waits for dependencies',",
              "  args: {},",
              "  execute: async () => ready,",
              "}",
              "",
            ].join("\n"),
          )
        },
      })

      const install = spyOn(Npm, "install").mockImplementation(async (dir: string) => {
        await new Promise((resolve) => setTimeout(resolve, 50))
        await writeMockConfigInstall(dir)
      })

      try {
        await Instance.provide({
          directory: tmp.path,
          fn: async () => {
            const ids = await ToolRegistry.ids()
            expect(ids).toContain("late")
          },
        })
        expect(
          install.mock.calls.some(([dir]) => path.normalize(dir) === path.normalize(path.join(tmp.path, ".opencode"))),
        ).toBe(true)
      } finally {
        install.mockRestore()
      }
    })
  })

  test("skips tools when config dependency install fails", async () => {
    await withConfigDepsLock(async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const toolsDir = path.join(dir, ".opencode", "tools")
          await fs.mkdir(toolsDir, { recursive: true })

          await Bun.write(
            path.join(toolsDir, "late.ts"),
            [
              "import { ready } from 'late-dep'",
              "export default {",
              "  description: 'tool with a missing dependency',",
              "  args: {},",
              "  execute: async () => ready,",
              "}",
              "",
            ].join("\n"),
          )

          await Bun.write(
            path.join(toolsDir, "local.ts"),
            [
              "export default {",
              "  description: 'tool without external dependencies',",
              "  args: {},",
              "  execute: async () => 'ok',",
              "}",
              "",
            ].join("\n"),
          )
        },
      })

      const install = spyOn(Npm, "install").mockImplementation(async () => {
        throw new Error("install failed")
      })

      try {
        await Instance.provide({
          directory: tmp.path,
          fn: async () => {
            const ids = await ToolRegistry.ids()
            expect(ids).not.toContain("late")
            expect(ids).toContain("local")
          },
        })
      } finally {
        install.mockRestore()
      }
    })
  })

  test("waits for in-progress config dependency installs before importing local tools", async () => {
    await withConfigDepsLock(async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const configDir = path.join(dir, ".opencode")
          const toolsDir = path.join(configDir, "tools")
          const depDir = path.join(configDir, "node_modules", "late-dep")
          await fs.mkdir(toolsDir, { recursive: true })
          await fs.mkdir(depDir, { recursive: true })

          await Bun.write(
            path.join(depDir, "package.json"),
            JSON.stringify({
              name: "late-dep",
              type: "module",
              exports: "./index.js",
            }),
          )

          await Bun.write(
            path.join(toolsDir, "late.ts"),
            [
              "import { ready } from 'late-dep'",
              "export default {",
              "  description: 'tool that waits for an install finishing its entrypoint',",
              "  args: {},",
              "  execute: async () => ready,",
              "}",
              "",
            ].join("\n"),
          )
        },
      })

      const install = spyOn(Npm, "install").mockImplementation((dir: string) => writeMockConfigInstall(dir))

      try {
        await Instance.provide({
          directory: tmp.path,
          fn: async () => {
            const ids = await ToolRegistry.ids()
            expect(ids).toContain("late")
          },
        })
        expect(
          install.mock.calls.some(([dir]) => path.normalize(dir) === path.normalize(path.join(tmp.path, ".opencode"))),
        ).toBe(true)
      } finally {
        install.mockRestore()
      }
    })
  })

  test("waits for config-scoped dependencies used through local helper imports", async () => {
    await withConfigDepsLock(async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const toolsDir = path.join(dir, ".opencode", "tools")
          await fs.mkdir(toolsDir, { recursive: true })

          await Bun.write(
            path.join(toolsDir, "helper.ts"),
            ["import { ready } from 'late-dep'", "export { ready }", ""].join("\n"),
          )

          await Bun.write(
            path.join(toolsDir, "late.ts"),
            [
              "import { ready } from './helper'",
              "export default {",
              "  description: 'tool that waits for helper dependencies',",
              "  args: {},",
              "  execute: async () => ready,",
              "}",
              "",
            ].join("\n"),
          )
        },
      })

      const install = spyOn(Npm, "install").mockImplementation((dir: string) => writeMockConfigInstall(dir))

      try {
        await Instance.provide({
          directory: tmp.path,
          fn: async () => {
            const ids = await ToolRegistry.ids()
            expect(ids).toContain("late")
          },
        })
        expect(
          install.mock.calls.some(([dir]) => path.normalize(dir) === path.normalize(path.join(tmp.path, ".opencode"))),
        ).toBe(true)
      } finally {
        install.mockRestore()
      }
    })
  })

  test("skips disabled tools before importing them", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const opencodeDir = path.join(dir, ".opencode")
        await fs.mkdir(opencodeDir, { recursive: true })

        const toolDir = path.join(opencodeDir, "tool")
        await fs.mkdir(toolDir, { recursive: true })

        await Bun.write(
          path.join(opencodeDir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            tools: {
              boom: false,
            },
          }),
        )

        await Bun.write(
          path.join(toolDir, "boom.ts"),
          ['throw new Error("disabled tool imported")', "export default {}", ""].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).not.toContain("boom")
      },
    })
  })

  test("skips disabled named-export tools before importing them", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const opencodeDir = path.join(dir, ".opencode")
        await fs.mkdir(opencodeDir, { recursive: true })

        const toolDir = path.join(opencodeDir, "tool")
        await fs.mkdir(toolDir, { recursive: true })

        await Bun.write(
          path.join(opencodeDir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            tools: {
              math_add: false,
              math_multiply: false,
            },
          }),
        )

        await Bun.write(
          path.join(toolDir, "math.ts"),
          [
            'throw new Error("disabled named tool imported")',
            "export const add = {}",
            "export const multiply = {}",
            "",
          ].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).not.toContain("math_add")
        expect(ids).not.toContain("math_multiply")
      },
    })
  })

  test("skips permission-disabled tools before importing them", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const opencodeDir = path.join(dir, ".opencode")
        await fs.mkdir(opencodeDir, { recursive: true })

        const toolDir = path.join(opencodeDir, "tool")
        await fs.mkdir(toolDir, { recursive: true })

        await Bun.write(
          path.join(opencodeDir, "opencode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            permission: {
              boom: "deny",
            },
          }),
        )

        await Bun.write(
          path.join(toolDir, "boom.ts"),
          ['throw new Error("permission disabled tool imported")', "export default {}", ""].join("\n"),
        )
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).not.toContain("boom")
      },
    })
  })

  test("excludes lsp tool when Settings.lspEnabled=false", async () => {
    await using tmp = await tmpdir()
    await Settings.setLspEnabled(false)
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).not.toContain("lsp")
      },
    })
  })

  test("does not register broken codesearch tool", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).not.toContain("codesearch")
      },
    })
  })

  test("registers lsp when Settings.lspEnabled=true but defers it out of the default model surface", async () => {
    await using tmp = await tmpdir()
    await Settings.setLspEnabled(true)
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const ids = await ToolRegistry.ids()
          expect(ids).toContain("lsp")

          const tools = await ToolRegistry.tools({
            providerID: ProviderID.make("openai"),
            modelID: ModelID.make("gpt-5"),
            agent: { name: "build", mode: "primary", permission: [], options: {} },
          })
          const surface = tools.map((tool) => tool.id)
          expect(surface).not.toContain("lsp")
          const card = tools.find((tool) => tool.id === "tool_info")!.description
          expect(card).toContain("lsp")
        },
      })
    } finally {
      await Settings.setLspEnabled(false)
    }
  })

  test("invalidate flips lsp visibility on next ids() call", async () => {
    await using tmp = await tmpdir()
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Settings.setLspEnabled(true)
          const before = await ToolRegistry.ids()
          expect(before).toContain("lsp")

          await Settings.setLspEnabled(false)
          await ToolRegistry.invalidate()
          const off = await ToolRegistry.ids()
          expect(off).not.toContain("lsp")

          await Settings.setLspEnabled(true)
          await ToolRegistry.invalidate()
          const on = await ToolRegistry.ids()
          expect(on).toContain("lsp")
        },
      })
    } finally {
      await Settings.setLspEnabled(false)
    }
  })

  test("exposes websearch for non-opencode providers without codesearch", async () => {
    await using tmp = await tmpdir()
    const previous = await Settings.webSearchEnabled()
    try {
      await Settings.setWebSearchEnabled(true)

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tools = await ToolRegistry.tools({
            providerID: ProviderID.make("openai"),
            modelID: ModelID.make("gpt-5"),
            agent: { name: "build", mode: "primary", permission: [], options: {} },
          })
          const ids = tools.map((tool) => tool.id)

          expect(ids).toContain("websearch")
          expect(ids).toContain("webfetch")
          expect(ids).not.toContain("codesearch")
        },
      })
    } finally {
      await Settings.setWebSearchEnabled(previous)
    }
  })

  test("invalidate flips websearch visibility without affecting webfetch", async () => {
    await using tmp = await tmpdir()
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Settings.setWebSearchEnabled(true)
          await ToolRegistry.invalidate()

          const visibleIds = await ToolRegistry.ids()
          expect(visibleIds).toContain("websearch")

          const visible = await ToolRegistry.tools({
            providerID: ProviderID.make("openai"),
            modelID: ModelID.make("gpt-5"),
            agent: { name: "build", mode: "primary", permission: [], options: {} },
          })
          expect(visible.map((tool) => tool.id)).toContain("websearch")

          await Settings.setWebSearchEnabled(false)
          await ToolRegistry.invalidate()

          const hiddenRegistryIds = await ToolRegistry.ids()
          expect(hiddenRegistryIds).not.toContain("websearch")

          const hidden = await ToolRegistry.tools({
            providerID: ProviderID.make("openai"),
            modelID: ModelID.make("gpt-5"),
            agent: { name: "build", mode: "primary", permission: [], options: {} },
          })
          const hiddenIds = hidden.map((tool) => tool.id)
          expect(hiddenIds).not.toContain("websearch")
          expect(hiddenIds).toContain("webfetch")
        },
      })
    } finally {
      await Settings.setWebSearchEnabled(true)
    }
  })

  test("does not advertise lsp as deferred when Settings.lspEnabled=false", async () => {
    await using tmp = await tmpdir()
    await Settings.setLspEnabled(false)
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tools = await ToolRegistry.tools({
          providerID: ProviderID.make("openai"),
          modelID: ModelID.make("gpt-5"),
          agent: { name: "build", mode: "primary", permission: [], options: {} },
        })
        const card = tools.find((tool) => tool.id === "tool_info")!.description
        expect(card).not.toContain("lsp")
      },
    })
  })

  test("rejects direct tool_info activation for lsp when Settings.lspEnabled=false", async () => {
    await using tmp = await tmpdir()
    await Settings.setLspEnabled(false)
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tools = await ToolRegistry.tools({
          providerID: ProviderID.make("openai"),
          modelID: ModelID.make("gpt-5"),
          agent: { name: "build", mode: "primary", permission: [], options: {} },
        })
        const toolInfo = tools.find((tool) => tool.id === "tool_info")!
        const ctx = {
          sessionID: SessionID.descending(),
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
          extra: {},
        }

        await expect(Effect.runPromise(toolInfo.execute({ name: "lsp" }, ctx))).rejects.toThrow(
          'Deferred tool "lsp" is not available in this context.',
        )
      },
    })
  })

  test("omits deferred repair hint for lsp when Settings.lspEnabled=false", async () => {
    await using tmp = await tmpdir()
    await Settings.setLspEnabled(false)
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const availableDeferredTools = await ToolRegistry.availableDeferred({
          deferredAvailable: () => true,
        })
        const repair = JSON.parse(
          LLM.buildInvalidToolRepairInput(
            {
              agent: { name: "build", mode: "primary", permission: [], options: {} },
              availableDeferredTools,
              permission: [],
              user: { tools: {} } as MessageV2.User,
            },
            "lsp",
            "Unknown tool: lsp",
          ),
        ) as { error: string }

        expect(repair.error).not.toContain('call tool_info with name="lsp"')
      },
    })
  })

  test("defers lsp and worktree tools until activated, and advertises them via tool_info", async () => {
    await using tmp = await tmpdir()
    await Settings.setLspEnabled(true)
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          // Default: deferred tools are not in the surface; tool_info is,
          // and advertises each available tool as a card.
          const def = await ToolRegistry.tools({
            providerID: ProviderID.make("openai"),
            modelID: ModelID.make("gpt-5"),
            agent: { name: "build", mode: "primary", permission: [], options: {} },
          })
          const defIds = def.map((tool) => tool.id)
          expect(defIds).toContain("automate")
          expect(defIds).not.toContain("enter-worktree")
          expect(defIds).not.toContain("exit-worktree")
          expect(defIds).not.toContain("lsp")
          expect(defIds).toContain("tool_info")
          const card = def.find((tool) => tool.id === "tool_info")!.description
          expect(card).not.toContain("automate")
          expect(card).toContain("enter-worktree")
          expect(card).toContain("exit-worktree")
          expect(card).toContain("lsp")

          // Activated: selected tools become callable; tool_info stops listing them.
          const act = await ToolRegistry.tools({
            providerID: ProviderID.make("openai"),
            modelID: ModelID.make("gpt-5"),
            agent: { name: "build", mode: "primary", permission: [], options: {} },
            activatedTools: new Set(["enter-worktree", "lsp"]),
          })
          const actIds = act.map((tool) => tool.id)
          expect(actIds).toContain("automate")
          expect(actIds).toContain("enter-worktree")
          expect(actIds).not.toContain("exit-worktree")
          expect(actIds).toContain("lsp")
          const actCard = act.find((tool) => tool.id === "tool_info")!.description
          expect(actCard).not.toContain("automate")
          expect(actCard).not.toContain("enter-worktree")
          expect(actCard).toContain("exit-worktree")
          expect(actCard).not.toContain("lsp")

          // Permission-disabled: even activated, it stays hidden and uncarded.
          const denied = await ToolRegistry.tools({
            providerID: ProviderID.make("openai"),
            modelID: ModelID.make("gpt-5"),
            agent: { name: "build", mode: "primary", permission: [], options: {} },
            activatedTools: new Set(["enter-worktree", "lsp"]),
            deferredAvailable: () => false,
          })
          expect(denied.map((tool) => tool.id)).toContain("automate")
          expect(denied.map((tool) => tool.id)).not.toContain("enter-worktree")
          expect(denied.map((tool) => tool.id)).not.toContain("lsp")
          expect(denied.find((tool) => tool.id === "tool_info")!.description).toContain("No deferred tools")
        },
      })
    } finally {
      await Settings.setLspEnabled(false)
    }
  })

  test("tool_info hands back exactly the schema the activated tool will expose, untruncated", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const base = {
          providerID: ProviderID.make("openai"),
          modelID: ModelID.make("gpt-5"),
          agent: { name: "build", mode: "primary" as const, permission: [], options: {} },
        }

        // Step 1: enter-worktree carries no full schema in the surface; only tool_info does.
        const deferred = await ToolRegistry.tools(base)
        expect(deferred.map((tool) => tool.id)).not.toContain("enter-worktree")
        const toolInfo = deferred.find((tool) => tool.id === "tool_info")!

        // The model in session context; tool_info must run the activated tool's raw
        // schema through the SAME ProviderTransform the request pipeline would, so what
        // it shows now matches what the model actually receives once the tool is live.
        const model = {
          id: "openai/gpt-5",
          providerID: "openai",
          api: { id: "gpt-5", url: "https://api.openai.com", npm: "@ai-sdk/openai" },
        } as unknown as Parameters<typeof ProviderTransform.schema>[0]

        // The schema the model will see once enter-worktree is activated, transformed.
        const activated = await ToolRegistry.tools({ ...base, activatedTools: new Set(["enter-worktree"]) })
        const enterWorktree = activated.find((tool) => tool.id === "enter-worktree")!
        const expectedSchema = ProviderTransform.schema(model, EffectZod.toJsonSchema(enterWorktree.parameters))

        const ctx = {
          sessionID: SessionID.descending(),
          messageID: MessageID.ascending(),
          agent: "build",
          abort: new AbortController().signal,
          messages: [],
          metadata: () => Effect.void,
          ask: () => Effect.void,
          extra: { model },
        }

        const result = await Effect.runPromise(toolInfo.execute({ name: "enter-worktree" }, ctx))
        const json = result.output.match(/```json\n([\s\S]*?)\n```/)?.[1]
        expect(json).toBeDefined()
        // tool_info's loaded schema is identical to the post-activation, provider-transformed schema.
        expect(JSON.parse(json!)).toEqual(expectedSchema)
        expect(result.metadata.activated).toBe("enter-worktree")
        // P3-2: the schema output opts out of truncation so a large tool never loads clipped.
        expect(result.metadata.truncated).toBe(false)

        // P3-1: a CamelCase echo still resolves to the canonical id.
        const camel = await Effect.runPromise(toolInfo.execute({ name: "Enter-Worktree" }, ctx))
        expect(camel.metadata.activated).toBe("enter-worktree")
      },
    })
  })
})
