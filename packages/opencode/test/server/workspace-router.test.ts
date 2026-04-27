import { $ } from "bun"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { pathToFileURL } from "url"
import { eq } from "../../src/storage/db"
import { Instance } from "../../src/project/instance"
import { Plugin } from "../../src/plugin"
import { Server } from "../../src/server/server"
import { WorkspaceID } from "../../src/control-plane/schema"
import { Workspace } from "../../src/control-plane/workspace"
import { WorkspaceTable } from "../../src/control-plane/workspace.sql"
import { Database } from "../../src/storage/db"
import { Log } from "@opencode-ai/core/util/log"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const disableDefault = process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS
process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = "1"

const { Flag } = await import("@opencode-ai/core/flag/flag")
const experimental = Flag.OPENCODE_EXPERIMENTAL_WORKSPACES

// @ts-expect-error - Flag is readonly at type level but mutable at runtime for test toggling
Flag.OPENCODE_EXPERIMENTAL_WORKSPACES = true

afterEach(async () => {
  await Instance.disposeAll()
  await resetDatabase()
})

afterAll(() => {
  if (disableDefault === undefined) delete process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS
  else process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = disableDefault

  // @ts-expect-error - Flag is readonly at type level but mutable at runtime for test toggling
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

      return { space, type }
    },
  })
}

describe("workspace router", () => {
  test("bootstraps the owning project before routing a persisted plugin workspace", async () => {
    await using tmp = await pluginProject()

    const workspace = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          yield* plugin.init()
          return Workspace.create({
            type: tmp.extra.type,
            branch: null,
            extra: null,
            projectID: Instance.project.id,
          })
        }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
    })

    await Instance.disposeAll()

    const app = Server.Default().app
    const response = await app.request(`/path?workspace=${workspace.id}`, {
      headers: {
        "x-opencode-directory": tmp.path,
      },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      directory: tmp.extra.space,
    })
  })

  test("tries project sandboxes when the plugin only exists in a secondary worktree", async () => {
    await using root = await tmpdir({ git: true })

    const worktreePath = path.join(root.path, "..", path.basename(root.path) + "-router-wt")
    const type = `plug-${Math.random().toString(36).slice(2)}`
    const plugin = path.join(worktreePath, "plugin.ts")
    const space = path.join(worktreePath, "space")

    try {
      await $`git worktree add ${worktreePath} -b test-router-${Date.now()}`.cwd(root.path).quiet()

      await Bun.write(
        plugin,
        [
          "export default async ({ experimental_workspace }) => {",
          `  experimental_workspace.register(${JSON.stringify(type)}, {`,
          '    name: "plug",',
          '    description: "worktree-only adaptor",',
          "    configure(input) {",
          `      return { ...input, name: "plug", branch: "plug/main", directory: ${JSON.stringify(space)} }`,
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
            plugin: [pathToFileURL(plugin).href],
          },
          null,
          2,
        ),
      )

      const workspace = await Instance.provide({
        directory: worktreePath,
        fn: async () =>
          Effect.gen(function* () {
            const plugin = yield* Plugin.Service
            yield* plugin.init()
            return Workspace.create({
              type,
              branch: null,
              extra: null,
              projectID: Instance.project.id,
            })
          }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
      })

      await Instance.disposeAll()

      const app = Server.Default().app
      const response = await app.request(`/path?workspace=${workspace.id}`, {
        headers: {
          "x-opencode-directory": root.path,
        },
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        directory: space,
      })
    } finally {
      await $`git worktree remove ${worktreePath}`
        .cwd(root.path)
        .quiet()
        .catch(() => {})
    }
  })

  test("routes a persisted workspace through its original checkout after the owner instance is disposed", async () => {
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
        "    target() {",
        `      return { type: "local", directory: ${JSON.stringify(rootSpace)} }`,
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

    const worktreePath = path.join(root.path, "..", path.basename(root.path) + "-router-shared")
    const worktreePlugin = path.join(worktreePath, "plugin.ts")
    const worktreeSpace = path.join(worktreePath, "worktree-space")

    try {
      await $`git worktree add ${worktreePath} -b test-shared-${Date.now()}`.cwd(root.path).quiet()
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
          "    target() {",
          `      return { type: "local", directory: ${JSON.stringify(worktreeSpace)} }`,
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

      const workspace = await Instance.provide({
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

      await Instance.provide({
        directory: worktreePath,
        fn: async () => Plugin.init(),
      })

      await Instance.provide({
        directory: root.path,
        fn: async () => Instance.dispose(),
      })

      const app = Server.Default().app
      const response = await app.request(`/path?workspace=${workspace.id}`, {
        headers: {
          "x-opencode-directory": worktreePath,
        },
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        directory: rootSpace,
      })
    } finally {
      await $`git worktree remove ${worktreePath}`
        .cwd(root.path)
        .quiet()
        .catch(() => {})
    }
  })

  test("keeps non-git workspace ownership separate by directory", async () => {
    await using first = await tmpdir()
    await using second = await tmpdir()

    const type = "shared"
    const firstPlugin = path.join(first.path, "plugin.ts")
    const firstSpace = path.join(first.path, "first-space")
    await Bun.write(
      firstPlugin,
      [
        "export default async ({ experimental_workspace }) => {",
        `  experimental_workspace.register(${JSON.stringify(type)}, {`,
        '    name: "first",',
        '    description: "first adaptor",',
        "    configure(input) {",
        `      return { ...input, name: "first", branch: null, directory: ${JSON.stringify(firstSpace)} }`,
        "    },",
        "    async create() {},",
        "    async remove() {},",
        "    target() {",
        `      return { type: "local", directory: ${JSON.stringify(firstSpace)} }`,
        "    },",
        "  })",
        "  return {}",
        "}",
        "",
      ].join("\n"),
    )
    await Bun.write(
      path.join(first.path, "opencode.json"),
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          plugin: [pathToFileURL(firstPlugin).href],
        },
        null,
        2,
      ),
    )

    const secondPlugin = path.join(second.path, "plugin.ts")
    const secondSpace = path.join(second.path, "second-space")
    await Bun.write(
      secondPlugin,
      [
        "export default async ({ experimental_workspace }) => {",
        `  experimental_workspace.register(${JSON.stringify(type)}, {`,
        '    name: "second",',
        '    description: "second adaptor",',
        "    configure(input) {",
        `      return { ...input, name: "second", branch: null, directory: ${JSON.stringify(secondSpace)} }`,
        "    },",
        "    async create() {},",
        "    async remove() {},",
        "    target() {",
        `      return { type: "local", directory: ${JSON.stringify(secondSpace)} }`,
        "    },",
        "  })",
        "  return {}",
        "}",
        "",
      ].join("\n"),
    )
    await Bun.write(
      path.join(second.path, "opencode.json"),
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          plugin: [pathToFileURL(secondPlugin).href],
        },
        null,
        2,
      ),
    )

    const workspace = await Instance.provide({
      directory: first.path,
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

    await Instance.provide({
      directory: second.path,
      fn: async () => Plugin.init(),
    })

    await Instance.provide({
      directory: first.path,
      fn: async () => Instance.dispose(),
    })

    const app = Server.Default().app
    const response = await app.request(`/path?workspace=${workspace.id}`, {
      headers: {
        "x-opencode-directory": second.path,
      },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      directory: firstSpace,
    })
  })

  test("routing a persisted remote workspace restarts background sync after cold start", async () => {
    let syncHits = 0
    let pathHits = 0

    await using remote = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === "/sync/event") {
          syncHits++
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.close()
              },
            }),
            {
              status: 200,
              headers: {
                "content-type": "text/event-stream",
              },
            },
          )
        }

        pathHits++
        return Response.json({ ok: true })
      },
    })

    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const type = `plug-${Math.random().toString(36).slice(2)}`
        const file = path.join(dir, "plugin.ts")
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
            "    target() {",
            `      return { type: "remote", url: ${JSON.stringify(remote.url.origin)} }`,
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

        return { type }
      },
    })

    const workspace = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Plugin.init()
        const id = WorkspaceID.ascending()
        Database.use((db) =>
          db.insert(WorkspaceTable)
            .values({
              id,
              type: tmp.extra.type,
              branch: "remote/main",
              name: "remote",
              directory: null,
              owner_directory: tmp.path,
              extra: null,
              project_id: Instance.project.id,
            })
            .run(),
        )
        return { id }
      },
    })

    const before = syncHits

    await Instance.disposeAll()

    const app = Server.Default().app
    const response = await app.request(`/path?workspace=${workspace.id}`, {
      headers: {
        "x-opencode-directory": tmp.path,
      },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })

    await wait(100)
    expect(pathHits).toBe(1)
    expect(syncHits).toBeGreaterThan(before)
  })

  test("fails explicitly when an upgraded workspace has no owner and multiple checkouts register the same type", async () => {
    await using root = await tmpdir({ git: true })

    const type = "shared"
    const rootPlugin = path.join(root.path, "plugin.ts")
    await Bun.write(
      rootPlugin,
      [
        "export default async ({ experimental_workspace }) => {",
        `  experimental_workspace.register(${JSON.stringify(type)}, {`,
        '    name: "root",',
        '    description: "root adaptor",',
        '    configure(input) { return { ...input, name: "root", branch: "root/main", directory: null } },',
        "    async create() {},",
        "    async remove() {},",
        '    target() { return { type: "local", directory: "/tmp/root-space" } },',
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

    const worktreePath = path.join(root.path, "..", path.basename(root.path) + "-router-null-owner")
    const worktreePlugin = path.join(worktreePath, "plugin.ts")

    try {
      await $`git worktree add ${worktreePath} -b test-null-owner-${Date.now()}`.cwd(root.path).quiet()
      await Bun.write(
        worktreePlugin,
        [
          "export default async ({ experimental_workspace }) => {",
          `  experimental_workspace.register(${JSON.stringify(type)}, {`,
          '    name: "worktree",',
          '    description: "worktree adaptor",',
          '    configure(input) { return { ...input, name: "worktree", branch: "worktree/main", directory: null } },',
          "    async create() {},",
          "    async remove() {},",
          '    target() { return { type: "local", directory: "/tmp/worktree-space" } },',
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

      const workspace = await Instance.provide({
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

      Database.use((db) =>
        db.update(WorkspaceTable).set({ owner_directory: null }).where(eq(WorkspaceTable.id, workspace.id)).run(),
      )

      await Instance.provide({
        directory: worktreePath,
        fn: async () => Plugin.init(),
      })

      const app = Server.Default().app
      const response = await app.request(`/path?workspace=${workspace.id}`, {
        headers: {
          "x-opencode-directory": worktreePath,
        },
      })

      expect(response.status).toBe(500)
    } finally {
      await $`git worktree remove ${worktreePath}`
        .cwd(root.path)
        .quiet()
        .catch(() => {})
    }
  })

  test("recovers a null-owner non-git workspace from the request directory when there is only one candidate", async () => {
    await using tmp = await tmpdir()

    const type = "shared"
    const plugin = path.join(tmp.path, "plugin.ts")
    const space = path.join(tmp.path, "space")
    await Bun.write(
      plugin,
      [
        "export default async ({ experimental_workspace }) => {",
        `  experimental_workspace.register(${JSON.stringify(type)}, {`,
        '    name: "single",',
        '    description: "single adaptor",',
        `    configure(input) { return { ...input, name: "single", branch: null, directory: ${JSON.stringify(space)} } },`,
        "    async create() {},",
        "    async remove() {},",
        `    target() { return { type: "local", directory: ${JSON.stringify(space)} } },`,
        "  })",
        "  return {}",
        "}",
        "",
      ].join("\n"),
    )
    await Bun.write(
      path.join(tmp.path, "opencode.json"),
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          plugin: [pathToFileURL(plugin).href],
        },
        null,
        2,
      ),
    )

    const workspace = await Instance.provide({
      directory: tmp.path,
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

    Database.use((db) =>
      db.update(WorkspaceTable).set({ owner_directory: null }).where(eq(WorkspaceTable.id, workspace.id)).run(),
    )
    await Instance.disposeAll()

    const app = Server.Default().app
    const response = await app.request(`/path?workspace=${workspace.id}`, {
      headers: {
        "x-opencode-directory": tmp.path,
      },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      directory: space,
    })
  })

  test("routing an ownerless non-git remote workspace restarts sync with the request directory hint", async () => {
    let syncHits = 0
    let pathHits = 0

    await using remote = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === "/sync/event") {
          syncHits++
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.close()
              },
            }),
            {
              status: 200,
              headers: {
                "content-type": "text/event-stream",
              },
            },
          )
        }

        pathHits++
        return Response.json({ ok: true })
      },
    })

    await using tmp = await tmpdir({
      init: async (dir) => {
        const type = `plug-${Math.random().toString(36).slice(2)}`
        const file = path.join(dir, "plugin.ts")
        await Bun.write(
          file,
          [
            "export default async ({ experimental_workspace }) => {",
            `  experimental_workspace.register(${JSON.stringify(type)}, {`,
            '    name: "remote",',
            '    description: "remote adaptor",',
            '    configure(input) { return { ...input, name: "remote", branch: null, directory: null } },',
            "    async create() {},",
            "    async remove() {},",
            "    target() {",
            `      return { type: "remote", url: ${JSON.stringify(remote.url.origin)} }`,
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

        return { type }
      },
    })

    const workspace = await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await Plugin.init()
        const id = WorkspaceID.ascending()
        Database.use((db) =>
          db.insert(WorkspaceTable)
            .values({
              id,
              type: tmp.extra.type,
              branch: null,
              name: "remote",
              directory: null,
              owner_directory: null,
              extra: null,
              project_id: Instance.project.id,
            })
            .run(),
        )
        return { id }
      },
    })

    await Instance.disposeAll()

    const app = Server.Default().app
    const response = await app.request(`/path?workspace=${workspace.id}`, {
      headers: {
        "x-opencode-directory": tmp.path,
      },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })

    await wait(100)
    expect(pathHits).toBe(1)
    expect(syncHits).toBeGreaterThan(0)
  })
})
