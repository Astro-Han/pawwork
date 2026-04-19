import { $ } from "bun"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdir } from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { eq } from "../../src/storage/db"
import { tmpdir } from "../fixture/fixture"
import { WorkspaceTable } from "../../src/control-plane/workspace.sql"
import { Database } from "../../src/storage/db"

const disableDefault = process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS
process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1"

const { Flag } = await import("../../src/flag/flag")
const { Plugin } = await import("../../src/plugin/index")
const { Workspace } = await import("../../src/control-plane/workspace")
const { Instance } = await import("../../src/project/instance")

const experimental = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES
// @ts-expect-error test-only flag override
Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true

afterEach(async () => {
  await Instance.disposeAll()
})

afterAll(() => {
  if (disableDefault === undefined) delete process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS
  else process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = disableDefault
  // @ts-expect-error test-only flag override
  Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = experimental
})

function wait(ms = 50) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function pluginProject() {
  return tmpdir({
    git: true,
    init: async (dir) => {
      const type = `plug-${Math.random().toString(36).slice(2)}`
      const file = path.join(dir, "plugin.ts")
      const mark = path.join(dir, "created.json")
      const space = path.join(dir, "space")
      await Bun.write(
        file,
        [
          "export default async ({ experimental_workspace }) => {",
          `  experimental_workspace.register(${JSON.stringify(type)}, {`,
          '    name: "plug",',
          '    description: "plugin workspace adaptor",',
          "    configure(input) {",
          `      return { ...input, name: "plug", branch: "plug/main", directory: ${JSON.stringify(space)} }`,
          "    },",
          "    async create(input) {",
          `      await Bun.write(${JSON.stringify(mark)}, JSON.stringify(input))`,
          "    },",
          "    async remove() {},",
          "    target(input) {",
          '      return { type: "local", directory: input.directory }',
          "    },",
          "  })",
          "  return {}",
          "}",
          "",
        ].join("\n"),
      )

      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify(
          {
            $schema: "https://opencode.ai/config.json",
            plugin: [pathToFileURL(file).href],
          },
          null,
          2,
        ),
      )

      return { mark, space, type }
    },
  })
}

describe("plugin.workspace", () => {
  test("plugin can install a workspace adaptor", async () => {
    await using tmp = await pluginProject()
    await mkdir(tmp.extra.space, { recursive: true })

    const info = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          yield* plugin.init()
          return Workspace.create({
            type: tmp.extra.type,
            branch: null,
            extra: { key: "value" },
            projectID: Instance.project.id,
          })
        }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
    })

    expect(info.type).toBe(tmp.extra.type)
    expect(info.name).toBe("plug")
    expect(info.branch).toBe("plug/main")
    expect(info.directory).toBe(tmp.extra.space)
    expect(info.extra).toEqual({ key: "value" })
    expect(JSON.parse(await Bun.file(tmp.extra.mark).text())).toMatchObject({
      type: tmp.extra.type,
      name: "plug",
      branch: "plug/main",
      directory: tmp.extra.space,
      extra: { key: "value" },
    })
    await wait(100)
    expect(Workspace.status().find((item) => item.workspaceID === info.id)?.status).not.toBe("connecting")
  })

  test("plugin workspace adaptor registration does not survive instance disposal", async () => {
    await using source = await pluginProject()

    await Instance.provide({
      directory: source.path,
      fn: async () =>
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          yield* plugin.init()
          return Workspace.create({
            type: source.extra.type,
            branch: null,
            extra: null,
            projectID: Instance.project.id,
          })
        }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
    })

    await Instance.disposeAll()

    await expect(
      Instance.provide({
        directory: source.path,
        fn: async () =>
          Workspace.create({
            type: source.extra.type,
            branch: null,
            extra: null,
            projectID: Instance.project.id,
          }),
      }),
    ).rejects.toThrow(/workspace adaptor/i)
  })

  test("disposing one checkout restores the previous adaptor for the same project and type", async () => {
    await using root = await tmpdir({ git: true })

    const type = "shared"
    const rootPlugin = path.join(root.path, "plugin.ts")
    const rootSpace = path.join(root.path, "root-space")
    await Bun.write(
      rootPlugin,
      [
        "export default async ({ experimental_workspace }) => {",
        `  experimental_workspace.register(${JSON.stringify(type)}, {`,
        '    name: "root",',
        '    description: "root adaptor",',
        "    configure(input) {",
        `      return { ...input, name: "root", branch: "root/main", directory: ${JSON.stringify(rootSpace)} }`,
        "    },",
        "    async create() {},",
        "    async remove() {},",
        "    target(input) {",
        '      return { type: "local", directory: input.directory }',
        "    },",
        "  })",
        "  return {}",
        "}",
        "",
      ].join("\n"),
    )
    await Bun.write(
      path.join(root.path, "opencode.json"),
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          plugin: [pathToFileURL(rootPlugin).href],
        },
        null,
        2,
      ),
    )

    const worktreePath = path.join(root.path, "..", path.basename(root.path) + "-plugin-wt")
    const worktreePlugin = path.join(worktreePath, "plugin.ts")
    const worktreeSpace = path.join(worktreePath, "worktree-space")

    try {
      await $`git worktree add ${worktreePath} -b test-plugin-${Date.now()}`.cwd(root.path).quiet()
      await Bun.write(
        worktreePlugin,
        [
          "export default async ({ experimental_workspace }) => {",
          `  experimental_workspace.register(${JSON.stringify(type)}, {`,
          '    name: "worktree",',
          '    description: "worktree adaptor",',
          "    configure(input) {",
          `      return { ...input, name: "worktree", branch: "worktree/main", directory: ${JSON.stringify(worktreeSpace)} }`,
          "    },",
          "    async create() {},",
          "    async remove() {},",
          "    target(input) {",
          '      return { type: "local", directory: input.directory }',
          "    },",
          "  })",
          "  return {}",
          "}",
          "",
        ].join("\n"),
      )
      await Bun.write(
        path.join(worktreePath, "opencode.json"),
        JSON.stringify(
          {
            $schema: "https://opencode.ai/config.json",
            plugin: [pathToFileURL(worktreePlugin).href],
          },
          null,
          2,
        ),
      )

      const fromRoot = await Instance.provide({
        directory: root.path,
        fn: async () => {
          await Plugin.init()
          return Workspace.create({
            type,
            branch: null,
            extra: null,
            projectID: Instance.project.id,
          })
        },
      })
      expect(fromRoot.directory).toBe(rootSpace)

      const fromWorktree = await Instance.provide({
        directory: worktreePath,
        fn: async () => {
          await Plugin.init()
          return Workspace.create({
            type,
            branch: null,
            extra: null,
            projectID: Instance.project.id,
          })
        },
      })
      expect(fromWorktree.directory).toBe(worktreeSpace)

      await Instance.provide({
        directory: worktreePath,
        fn: async () => Instance.dispose(),
      })

      const restored = await Instance.provide({
        directory: root.path,
        fn: async () =>
          Workspace.create({
            type,
            branch: null,
            extra: null,
            projectID: Instance.project.id,
          }),
      })
      expect(restored.directory).toBe(rootSpace)
    } finally {
      await $`git worktree remove ${worktreePath}`
        .cwd(root.path)
        .quiet()
        .catch(() => {})
    }
  })

  test("cold-start Workspace.get retries sync after owner bootstrap for remote adaptors", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const type = `plug-${Math.random().toString(36).slice(2)}`
        const file = path.join(dir, "plugin.ts")
        const counter = path.join(dir, "target-count.txt")
        await Bun.write(counter, "0")
        await Bun.write(
          file,
          [
            "export default async ({ experimental_workspace }) => {",
            `  experimental_workspace.register(${JSON.stringify(type)}, {`,
            '    name: "remote",',
            '    description: "remote adaptor",',
            '    configure(input) { return { ...input, name: "remote", branch: "remote/main", directory: null } },',
            "    async create() {},",
            "    async remove() {},",
            "    async target() {",
            `      const file = Bun.file(${JSON.stringify(counter)})`,
            '      const count = Number((await file.text()) || "0") + 1',
            `      await Bun.write(${JSON.stringify(counter)}, String(count))`,
            '      throw new Error("target unavailable")',
            "    },",
            "  })",
            "  return {}",
            "}",
            "",
          ].join("\n"),
        )

        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify(
            {
              $schema: "https://opencode.ai/config.json",
              plugin: [pathToFileURL(file).href],
            },
            null,
            2,
          ),
        )

        return { counter, type }
      },
    })

    const workspace = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Plugin.init()
        return Workspace.create({
          type: tmp.extra.type,
          branch: null,
          extra: null,
          projectID: Instance.project.id,
        })
      },
    })

    await Instance.disposeAll()

    await Workspace.get(workspace.id)
    await wait(100)
    const first = Number(await Bun.file(tmp.extra.counter).text())
    expect(first).toBeGreaterThan(0)

    await Workspace.get(workspace.id)
    await wait(100)
    const second = Number(await Bun.file(tmp.extra.counter).text())
    expect(second).toBeGreaterThan(first)

    const status = Workspace.status().find((item) => item.workspaceID === workspace.id)
    expect(status?.error).toContain("target unavailable")
  })

  test("plugin cannot shadow the built-in worktree adaptor", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const file = path.join(dir, "plugin.ts")
        await Bun.write(
          file,
          [
            "export default async ({ experimental_workspace }) => {",
            '  experimental_workspace.register("worktree", {',
            '    name: "shadow",',
            '    description: "shadow builtin",',
            '    configure(input) { return { ...input, name: "shadow", branch: "shadow/main", directory: input.directory } },',
            "    async create() {},",
            "    async remove() {},",
            '    target(input) { return { type: "local", directory: input.directory } },',
            "  })",
            "  return {}",
            "}",
            "",
          ].join("\n"),
        )

        await Bun.write(
          path.join(dir, "opencode.json"),
          JSON.stringify(
            {
              $schema: "https://opencode.ai/config.json",
              plugin: [pathToFileURL(file).href],
            },
            null,
            2,
          ),
        )
      },
    })

    const info = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Plugin.init()
        return Workspace.create({
          type: "worktree",
          branch: null,
          extra: null,
          projectID: Instance.project.id,
        })
      },
    })

    expect(info.name).not.toBe("shadow")
    expect(info.branch).not.toBe("shadow/main")

    await Instance.provide({
      directory: tmp.path,
      fn: async () => Workspace.remove(info.id),
    })
  })

  test("Workspace.get recovers a null-owner non-git workspace when called from its original directory", async () => {
    await using tmp = await pluginProject()

    const workspace = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Plugin.init()
        return Workspace.create({
          type: tmp.extra.type,
          branch: null,
          extra: null,
          projectID: Instance.project.id,
        })
      },
    })

    Database.use((db) =>
      db.update(WorkspaceTable).set({ owner_directory: null }).where(eq(WorkspaceTable.id, workspace.id)).run(),
    )
    await Instance.disposeAll()

    const reloaded = await Instance.provide({
      directory: tmp.path,
      fn: async () => Workspace.get(workspace.id),
    })

    expect(reloaded?.id).toBe(workspace.id)
    expect(
      Workspace.status()
        .find((item) => item.workspaceID === workspace.id)
        ?.error?.includes("Unknown workspace adaptor") ?? false,
    ).toBe(false)
  })
})
