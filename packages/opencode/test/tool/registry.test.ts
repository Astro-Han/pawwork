import { afterEach, describe, expect, spyOn, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { writeMockConfigInstall } from "../shared/mock-npm-install"
import { Instance } from "../../src/project/instance"
import { ToolRegistry } from "../../src/tool/registry"
import { Npm } from "../../src/npm"
import { Config } from "../../src/config/config"
import { needsConfigDependencies } from "../../src/config/dependency"
import { Global } from "../../src/global"
import { withTimeout } from "../../src/util/timeout"

afterEach(async () => {
  await Instance.disposeAll()
})

async function withPlatform<T>(value: NodeJS.Platform, fn: () => Promise<T>) {
  const previous = process.platform
  Object.defineProperty(process, "platform", {
    value,
    configurable: true,
  })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, "platform", {
      value: previous,
      configurable: true,
    })
  }
}

describe("tool.registry", () => {
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
    await using tmp = await tmpdir({
      init: async (dir) => {
        const toolsDir = path.join(dir, ".opencode", "tools")
        await fs.mkdir(toolsDir, { recursive: true })

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

  test("waits for config-scoped dependencies used through local helper imports", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const toolsDir = path.join(dir, ".opencode", "tools")
        await fs.mkdir(toolsDir, { recursive: true })

        await Bun.write(path.join(toolsDir, "helper.ts"), ["import { ready } from 'late-dep'", "export { ready }", ""].join("\n"))

        await Bun.write(
          path.join(toolsDir, "late.ts"),
          [
            "import { ready } from './helper'",
            "export default {",
            "  description: 'tool that reaches deps through helper imports',",
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

  test("does not wait on local config installs for helper files with type-only imports or exports", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const toolsDir = path.join(dir, ".opencode", "tools")
        await fs.mkdir(toolsDir, { recursive: true })

        await Bun.write(
          path.join(toolsDir, "helper.ts"),
          [
            "import type { Missing } from 'late-dep'",
            "export type { Missing } from 'late-dep'",
            "import { type Missing as InlineImport } from 'late-dep'",
            "export { type Missing as InlineExport } from 'late-dep'",
            "export const ready = 'local'",
            "",
          ].join("\n"),
        )

        await Bun.write(
          path.join(toolsDir, "late.ts"),
          [
            "import { ready } from './helper'",
            "export default {",
            "  description: 'tool with helper type-only imports or exports',",
            "  args: {},",
            "  execute: async () => ready,",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    let release = () => {}
    let started = () => {}
    let idsTask: Promise<string[]> | undefined
    const installing = new Promise<void>((resolve) => {
      release = resolve
    })
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const localConfigDir = path.join(tmp.path, ".opencode")
    const install = spyOn(Npm, "install").mockImplementation(async (dir: string) => {
      if (path.normalize(dir) === path.normalize(localConfigDir)) {
        started()
        await installing
      }
      await writeMockConfigInstall(dir)
    })

    try {
      idsTask = Instance.provide({
        directory: tmp.path,
        fn: () => ToolRegistry.ids(),
      }).then((ids) => ids)

      await ready

      await expect(withTimeout(idsTask, 2_000)).resolves.toContain("late")
    } finally {
      release()
      await idsTask?.catch(() => undefined)
      install.mockRestore()
    }
  })

  test("ignores multiline type-only dependency imports and exports when scanning config dependencies", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const toolsDir = path.join(dir, ".opencode", "tools")
        await fs.mkdir(toolsDir, { recursive: true })

        await Bun.write(
          path.join(toolsDir, "helper.ts"),
          [
            "import type",
            "  { Missing as MultilineImport } from 'late-dep'",
            "export type",
            "  { Missing as MultilineExport } from 'late-dep'",
            "import { type",
            "  Missing as InlineMultilineImport } from 'late-dep'",
            "export { type",
            "  Missing as InlineMultilineExport } from 'late-dep'",
            "export const ready = 'local'",
            "",
          ].join("\n"),
        )
      },
    })

    await expect(
      needsConfigDependencies(path.join(tmp.path, ".opencode", "tools", "helper.ts"), path.join(tmp.path, ".opencode")),
    ).resolves.toBe(false)
  })

  test("keeps runtime imports and exports for bindings literally named type", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const toolsDir = path.join(dir, ".opencode", "tools")
        await fs.mkdir(toolsDir, { recursive: true })

        await Bun.write(
          path.join(toolsDir, "helper.ts"),
          [
            "import { type as RuntimeImport } from 'late-dep'",
            "export { type as RuntimeExport } from 'late-dep'",
            "export const ready = 'local'",
            "",
          ].join("\n"),
        )
      },
    })

    await expect(
      needsConfigDependencies(path.join(tmp.path, ".opencode", "tools", "helper.ts"), path.join(tmp.path, ".opencode")),
    ).resolves.toBe(true)
  })

  test("does not wait for unrelated global config installs before importing local tools with bare imports", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const toolsDir = path.join(dir, ".opencode", "tools")
        await fs.mkdir(toolsDir, { recursive: true })

        await Bun.write(
          path.join(toolsDir, "late.ts"),
          [
            "import { ready } from 'late-dep'",
            "export default {",
            "  description: 'tool that only needs local config deps',",
            "  args: {},",
            "  execute: async () => ready,",
            "}",
            "",
          ].join("\n"),
        )
      },
    })

    const prevGlobal = Global.Path.config
    let globalDir = ""
    let release = () => {}
    let started = () => {}
    let idsTask: Promise<string[]> | undefined
    const installing = new Promise<void>((resolve) => {
      release = resolve
    })
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const install = spyOn(Npm, "install").mockImplementation(async (dir: string) => {
      if (path.normalize(dir) === path.normalize(globalDir)) {
        started()
        await installing
      }
      await writeMockConfigInstall(dir)
    })

    try {
      globalDir = path.join(tmp.path, "global")
      await fs.mkdir(globalDir, { recursive: true })
      ;(Global.Path as { config: string }).config = globalDir
      await Config.invalidate(true)

      idsTask = Instance.provide({
        directory: tmp.path,
        fn: () => ToolRegistry.ids(),
      }).then((ids) => ids)

      await ready

      await expect(withTimeout(idsTask, 2_000)).resolves.toContain("late")
    } finally {
      release()
      await idsTask?.catch(() => undefined)
      install.mockRestore()
      ;(Global.Path as { config: string }).config = prevGlobal
      await Config.invalidate(true)
    }
  })

  test("does not wait for unrelated global config installs on Windows before importing local tools with bare imports", async () => {
    await withPlatform("win32", async () => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const toolsDir = path.join(dir, ".opencode", "tools")
          await fs.mkdir(toolsDir, { recursive: true })

          await Bun.write(
            path.join(toolsDir, "late.ts"),
            [
              "import { ready } from 'late-dep'",
              "export default {",
              "  description: 'tool that only needs local config deps',",
              "  args: {},",
              "  execute: async () => ready,",
              "}",
              "",
            ].join("\n"),
          )
        },
      })

      const prevGlobal = Global.Path.config
      let globalDir = ""
      let release = () => {}
      let started = () => {}
      let idsTask: Promise<string[]> | undefined
      const installing = new Promise<void>((resolve) => {
        release = resolve
      })
      const ready = new Promise<void>((resolve) => {
        started = resolve
      })
      const install = spyOn(Npm, "install").mockImplementation(async (dir: string) => {
        if (path.normalize(dir) === path.normalize(globalDir)) {
          started()
          await installing
        }
        await writeMockConfigInstall(dir)
      })

      try {
        globalDir = path.join(tmp.path, "global")
        await fs.mkdir(globalDir, { recursive: true })
        ;(Global.Path as { config: string }).config = globalDir
        await Config.invalidate(true)

        idsTask = Instance.provide({
          directory: tmp.path,
          fn: () => ToolRegistry.ids(),
        }).then((ids) => ids)

        await ready

        await expect(withTimeout(idsTask, 2_000)).resolves.toContain("late")
      } finally {
        release()
        await idsTask?.catch(() => undefined)
        install.mockRestore()
        ;(Global.Path as { config: string }).config = prevGlobal
        await Config.invalidate(true)
      }
    })
  })

  test("serializes concurrent Windows local tool dependency installs across directories", async () => {
    await withPlatform("win32", async () => {
      async function createToolProject() {
        return await tmpdir({
          init: async (dir) => {
            const toolsDir = path.join(dir, ".opencode", "tools")
            await fs.mkdir(toolsDir, { recursive: true })
            await Bun.write(
              path.join(toolsDir, "late.ts"),
              [
                "import { ready } from 'late-dep'",
                "export default {",
                "  description: 'tool that needs local config deps',",
                "  args: {},",
                "  execute: async () => ready,",
                "}",
                "",
              ].join("\n"),
            )
          },
        })
      }

      await using first = await createToolProject()
      await using second = await createToolProject()

      const targets = new Set([
        path.normalize(path.join(first.path, ".opencode")),
        path.normalize(path.join(second.path, ".opencode")),
      ])
      let open = 0
      let peak = 0
      let calls = 0
      let release = () => {}
      let started = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const firstInstall = new Promise<void>((resolve) => {
        started = resolve
      })
      const install = spyOn(Npm, "install").mockImplementation(async (dir: string) => {
        const key = path.normalize(dir)
        const hit = targets.has(key)
        if (hit) {
          calls += 1
          open += 1
          peak = Math.max(peak, open)
          if (calls === 1) {
            started()
            await gate
          }
        }
        await writeMockConfigInstall(dir)
        if (hit) {
          open -= 1
        }
      })

      try {
        const firstIds = Instance.provide({
          directory: first.path,
          fn: () => ToolRegistry.ids(),
        })
        await firstInstall

        const secondIds = Instance.provide({
          directory: second.path,
          fn: () => ToolRegistry.ids(),
        })
        await Bun.sleep(100)
        release()

        await expect(firstIds).resolves.toContain("late")
        await expect(secondIds).resolves.toContain("late")
      } finally {
        release()
        install.mockRestore()
        await Config.invalidate(true)
      }

      expect(calls).toBe(2)
      expect(peak).toBe(1)
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
