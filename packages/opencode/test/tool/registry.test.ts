import { afterEach, describe, expect, spyOn, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
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

  test("exposes automate now that the Automations panel ships", async () => {
    await using tmp = await tmpdir()

    await withMockedConfigInstall(async () => {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const ids = await ToolRegistry.ids()
          expect(ids).toContain("automate")
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

  test("local tool import spec normalizes filesystem paths to file URLs", () => {
    const toolPath = path.resolve("pawwork-tools", "marked.ts")
    expect(localToolImportSpec(toolPath)).toStartWith("file://")
    expect(localToolImportSpec(toolPath)).not.toBe(toolPath)
    expect(localToolImportSpec("C:\\Users\\test\\tool.ts")).toStartWith("file://")
    expect(localToolImportSpec("C:\\Users\\test\\tool.ts")).not.toBe("C:\\Users\\test\\tool.ts")
    expect(localToolImportSpec("file:///tmp/tool.ts")).toBe("file:///tmp/tool.ts")
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

  test("includes lsp tool when Settings.lspEnabled=true", async () => {
    await using tmp = await tmpdir()
    await Settings.setLspEnabled(true)
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const ids = await ToolRegistry.ids()
          expect(ids).toContain("lsp")
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

  test("defers worktree tools until activated, and advertises them via tool_info", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        // Default: deferred worktree tools are not in the surface; tool_info is,
        // and advertises both as cards.
        const def = await ToolRegistry.tools({
          providerID: ProviderID.make("openai"),
          modelID: ModelID.make("gpt-5"),
          agent: { name: "build", mode: "primary", permission: [], options: {} },
        })
        const defIds = def.map((tool) => tool.id)
        expect(defIds).not.toContain("enter-worktree")
        expect(defIds).not.toContain("exit-worktree")
        expect(defIds).toContain("tool_info")
        const card = def.find((tool) => tool.id === "tool_info")!.description
        expect(card).toContain("enter-worktree")
        expect(card).toContain("exit-worktree")

        // Activated: enter-worktree becomes callable; tool_info stops listing it.
        const act = await ToolRegistry.tools({
          providerID: ProviderID.make("openai"),
          modelID: ModelID.make("gpt-5"),
          agent: { name: "build", mode: "primary", permission: [], options: {} },
          activatedTools: new Set(["enter-worktree"]),
        })
        const actIds = act.map((tool) => tool.id)
        expect(actIds).toContain("enter-worktree")
        expect(actIds).not.toContain("exit-worktree")
        const actCard = act.find((tool) => tool.id === "tool_info")!.description
        expect(actCard).not.toContain("enter-worktree")
        expect(actCard).toContain("exit-worktree")

        // Permission-disabled: even activated, it stays hidden and uncarded.
        const denied = await ToolRegistry.tools({
          providerID: ProviderID.make("openai"),
          modelID: ModelID.make("gpt-5"),
          agent: { name: "build", mode: "primary", permission: [], options: {} },
          activatedTools: new Set(["enter-worktree"]),
          deferredAvailable: () => false,
        })
        expect(denied.map((tool) => tool.id)).not.toContain("enter-worktree")
        expect(denied.find((tool) => tool.id === "tool_info")!.description).toContain("No deferred tools")
      },
    })
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
