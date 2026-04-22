import { afterEach, describe, expect, spyOn, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { writeMockConfigInstall } from "../shared/mock-npm-install"
import { withConfigDepsLock } from "../shared/config-deps-lock"
import { Instance } from "../../src/project/instance"
import { localToolImportSpec, ToolRegistry } from "../../src/tool/registry"
import { Npm } from "../../src/npm"

afterEach(async () => {
  await Instance.disposeAll()
})

describe("tool.registry", () => {
  test("exposes trash tool", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("trash")
      },
    })
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

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("hello")
      },
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

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const ids = await ToolRegistry.ids()
        expect(ids).toContain("hello")
      },
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
    await using tmp = await tmpdir({
      init: async (dir) => {
        const opencodeDir = path.join(dir, ".opencode")
        await fs.mkdir(opencodeDir, { recursive: true })

        const toolsDir = path.join(opencodeDir, "tools")
        await fs.mkdir(toolsDir, { recursive: true })

        await Bun.write(
          path.join(opencodeDir, "package.json"),
          JSON.stringify({
            name: "custom-tools",
            dependencies: {
              "@opencode-ai/plugin": "^0.0.0",
              cowsay: "^1.6.0",
            },
          }),
        )

        await Bun.write(
          path.join(opencodeDir, "package-lock.json"),
          JSON.stringify({
            name: "custom-tools",
            lockfileVersion: 3,
            packages: {
              "": {
                dependencies: {
                  "@opencode-ai/plugin": "^0.0.0",
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
})
