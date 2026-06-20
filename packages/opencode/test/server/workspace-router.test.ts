import { $ } from "bun"
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import fs from "fs/promises"
import { Hono } from "hono"
import path from "path"
import { pathToFileURL } from "url"
import { AppRuntime } from "../../src/effect/app-runtime"
import { InstanceRef, WorkspaceRef } from "../../src/effect/instance-ref"
import { eq } from "../../src/storage/db"
import { WorkspaceContext } from "../../src/control-plane/workspace-context"
import { Instance } from "../../src/project/instance"
import { Plugin } from "../../src/plugin"
import { Server } from "../../src/server/server"
import { WorkspaceRouterMiddleware } from "../../src/server/instance/middleware"
import { resolveWorkspaceRoute, WorkspaceRoutingError } from "../../src/server/instance/workspace-routing"
import { WorkspaceID } from "../../src/control-plane/schema"
import { Workspace } from "../../src/control-plane/workspace"
import { WorkspaceTable } from "../../src/control-plane/workspace.sql"
import { Database } from "../../src/storage/db"
import { Log } from "@opencode-ai/core/util/log"
import { currentRequestContext } from "../../src/server/request-context"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"
import { Session } from "../../src/session"
import { ServerProxy } from "../../src/server/proxy"

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

function disableWorkspaceSync() {
  return spyOn(Workspace, "ensureSync").mockImplementation(() => {})
}

async function readEffectContext() {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const instance = yield* InstanceRef
      const workspaceID = yield* WorkspaceRef
      return {
        directory: instance?.directory,
        workspaceID: workspaceID ?? null,
      }
    }),
  )
}

async function writeOpencodeConfig(dir: string, pluginFile: string) {
  await Bun.write(
    path.join(dir, "opencode.json"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        plugin: [pathToFileURL(pluginFile).href],
      },
      null,
      2,
    ),
  )
}

async function writeRemoteWorkspacePlugin(input: {
  dir: string
  url: string
  branch?: string | null
  targetError?: string
  targetValue?: string
}) {
  const type = `plug-${Math.random().toString(36).slice(2)}`
  const file = path.join(input.dir, "plugin.ts")
  const branch = input.branch === undefined ? null : input.branch
  await Bun.write(
    file,
    [
      "export default async ({ experimental_workspace }) => {",
      `  experimental_workspace.register(${JSON.stringify(type)}, {`,
      '    name: "remote",',
      '    description: "remote adaptor",',
      `    configure(input) { return { ...input, name: "remote", branch: ${JSON.stringify(branch)}, directory: null } },`,
      "    async create() {},",
      "    async remove() {},",
      "    target() {",
      input.targetError
        ? `      throw new Error(${JSON.stringify(input.targetError)})`
        : input.targetValue
          ? `      return ${input.targetValue}`
        : `      return { type: "remote", url: ${JSON.stringify(input.url)} }`,
      "    },",
      "  })",
      "  return {}",
      "}",
      "",
    ].join("\n"),
  )
  await writeOpencodeConfig(input.dir, file)
  return { type }
}

async function writeLocalWorkspacePlugin(input: { dir: string; name?: string; directory?: string; type?: string }) {
  const type = input.type ?? `plug-${Math.random().toString(36).slice(2)}`
  const name = input.name ?? "local"
  const directory = input.directory ?? input.dir
  const file = path.join(input.dir, "plugin.ts")
  await Bun.write(
    file,
    [
      "export default async ({ experimental_workspace }) => {",
      `  experimental_workspace.register(${JSON.stringify(type)}, {`,
      `    name: ${JSON.stringify(name)},`,
      `    description: ${JSON.stringify(`${name} adaptor`)},`,
      "    configure(input) {",
      `      return { ...input, name: ${JSON.stringify(name)}, branch: null, directory: ${JSON.stringify(directory)} }`,
      "    },",
      "    async create() {},",
      "    async remove() {},",
      "    target(input) { return { type: \"local\", directory: input.directory } }",
      "  })",
      "  return {}",
      "}",
      "",
    ].join("\n"),
  )
  await writeOpencodeConfig(input.dir, file)
  return { type }
}

async function persistRemoteWorkspace(input: { directory: string; type: string; branch?: string | null }) {
  return Instance.provide({
    directory: input.directory,
    fn: async () => {
      await Plugin.init()
      const id = WorkspaceID.ascending()
      Database.use((db) =>
        db.insert(WorkspaceTable)
          .values({
            id,
            type: input.type,
            branch: input.branch ?? null,
            name: "remote",
            directory: null,
            owner_directory: input.directory,
            extra: null,
            project_id: Instance.project.id,
          })
          .run(),
      )
      return { id }
    },
  })
}

async function createLocalWorkspace(input: { directory: string; type: string }) {
  return Instance.provide({
    directory: input.directory,
    fn: async () => {
      await Plugin.init()
      return Workspace.create({
        type: input.type,
        branch: null,
        extra: null,
        projectID: Instance.project.id,
      })
    },
  })
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
  test("provides instance and request context for no-workspace local routes", async () => {
    await using tmp = await tmpdir()
    const app = new Hono()
    app.use(WorkspaceRouterMiddleware(() => undefined as never))
    app.get("/context", async (c) =>
      c.json({
        directory: Instance.current.directory,
        effect: await readEffectContext(),
        request: currentRequestContext(),
      }),
    )

    const response = await app.request(`/context?directory=${encodeURIComponent(tmp.path)}`, {
      headers: {
        "x-pawwork-client-action-id": "client-action-workspace-router",
        "x-pawwork-client-action-kind": "project.git.init",
      },
    })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.directory).toBe(tmp.path)
    expect(body.effect).toEqual({
      directory: tmp.path,
      workspaceID: null,
    })
    expect(Instance.directories()).toContain(tmp.path)
    expect(body.request).toMatchObject({
      method: "GET",
      path: "/context",
      client_action: {
        id: "client-action-workspace-router",
        kind: "project.git.init",
      },
    })
    expect(JSON.stringify(body.request)).not.toContain(tmp.path)
  })

  test("provides target instance, workspace, and request context for local workspace routes", async () => {
    await using tmp = await tmpdir()
    const space = path.join(tmp.path, "space")
    await fs.mkdir(space, { recursive: true })
    const plugin = await writeLocalWorkspacePlugin({ dir: tmp.path, directory: space })
    const workspace = await createLocalWorkspace({ directory: tmp.path, type: plugin.type })
    await Instance.disposeAll()

    const app = new Hono()
    app.use(WorkspaceRouterMiddleware(() => undefined as never))
    app.get("/context", async (c) =>
      c.json({
        directory: Instance.current.directory,
        workspaceID: WorkspaceContext.workspaceID,
        effect: await readEffectContext(),
        request: currentRequestContext(),
      }),
    )

    const response = await app.request(`/context?workspace=${workspace.id}`, {
      headers: {
        "x-opencode-directory": tmp.path,
        "x-pawwork-client-action-id": "client-action-local-workspace",
        "x-pawwork-client-action-kind": "project.git.init",
      },
    })
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.directory).toBe(space)
    expect(body.workspaceID).toBe(workspace.id)
    expect(body.effect).toEqual({
      directory: space,
      workspaceID: workspace.id,
    })
    expect(Instance.directories()).toContain(space)
    expect(body.request).toMatchObject({
      method: "GET",
      path: "/context",
      workspace_id: workspace.id,
      client_action: {
        id: "client-action-local-workspace",
        kind: "project.git.init",
      },
    })
    expect(JSON.stringify(body.request)).not.toContain(tmp.path)
    expect(JSON.stringify(body.request)).not.toContain(space)
  })

  test("keeps GET session detail routes local while forwarding session status", async () => {
    let remoteHits = 0
    await using remote = Bun.serve({
      port: 0,
      fetch() {
        remoteHits++
        return Response.json({ remote: true })
      },
    })

    await using tmp = await tmpdir({
      init: (dir) => writeRemoteWorkspacePlugin({ dir, url: remote.url.origin }),
    })

    const workspace = await persistRemoteWorkspace({ directory: tmp.path, type: tmp.extra.type })

    await Instance.disposeAll()

    const ensureSync = disableWorkspaceSync()

    try {
      const app = Server.Default().app
      const detail = await app.request(`/session/ses_missing?workspace=${workspace.id}`, {
        headers: {
          "x-opencode-directory": tmp.path,
        },
      })

      expect(detail.status).toBe(404)
      expect(remoteHits).toBe(0)

      const status = await app.request(`/session/status?workspace=${workspace.id}`, {
        headers: {
          "x-opencode-directory": tmp.path,
        },
      })

      expect(status.status).toBe(200)
      expect(await status.json()).toEqual({ remote: true })
      expect(remoteHits).toBe(1)
    } finally {
      ensureSync.mockRestore()
    }
  })

  test("keeps GET session list on the current local route for remote workspaces", async () => {
    let remoteHits = 0
    await using remote = Bun.serve({
      port: 0,
      fetch() {
        remoteHits++
        return Response.json({ remote: true })
      },
    })

    await using tmp = await tmpdir({
      init: (dir) => writeRemoteWorkspacePlugin({ dir, url: remote.url.origin }),
    })

    const workspace = await persistRemoteWorkspace({ directory: tmp.path, type: tmp.extra.type })

    await Instance.disposeAll()

    const ensureSync = disableWorkspaceSync()

    try {
      const app = Server.Default().app
      const response = await app.request(`/session?workspace=${workspace.id}`, {
        headers: {
          "x-opencode-directory": tmp.path,
        },
      })

      expect(response.status).toBe(500)
      const body = await response.json()
      expect(body.name).toBe("UnknownError")
      // The unexpected 500 body is intentionally redacted to a constant (the internal
      // routing error stays in the server log only); see ErrorMiddleware.
      expect(body.data.message).toBe("Unexpected server error. Check server logs for details.")
      expect(remoteHits).toBe(0)
    } finally {
      ensureSync.mockRestore()
    }
  })

  test("returns an explicit error when a workspace record is missing", async () => {
    await using tmp = await tmpdir()

    const app = Server.Default().app
    const response = await app.request(`/path?workspace=${WorkspaceID.ascending()}`, {
      headers: {
        "x-opencode-directory": tmp.path,
      },
    })

    expect(response.status).toBe(500)
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    expect(await response.text()).toStartWith("Workspace not found: wrk_")
  })

  test("routes session delete past a missing workspace record", async () => {
    await using tmp = await tmpdir()

    const app = Server.Default().app
    const response = await app.request(`/session/ses_missing?workspace=${WorkspaceID.ascending()}`, {
      method: "DELETE",
      headers: {
        "x-opencode-directory": tmp.path,
      },
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({
      name: "NotFoundError",
      data: {
        message: "Session not found: ses_missing",
      },
    })
  })

  test("uses a session workspace before the workspace query parameter for mutating session routes", async () => {
    let remoteHits = 0
    await using remote = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname !== "/sync/event") remoteHits++
        return Response.json({ routed: "session-workspace" })
      },
    })

    await using first = await tmpdir({
      init: (dir) => writeRemoteWorkspacePlugin({ dir, url: remote.url.origin }),
    })
    await using second = await tmpdir({
      init: (dir) => writeLocalWorkspacePlugin({ dir }),
    })

    const remoteWorkspace = await persistRemoteWorkspace({ directory: first.path, type: first.extra.type })
    const localWorkspace = await createLocalWorkspace({ directory: second.path, type: second.extra.type })
    const session = await Instance.provide({
      directory: first.path,
      fn: () => AppRuntime.runPromise(Session.Service.use((svc) => svc.create({ workspaceID: remoteWorkspace.id }))),
    })

    await Instance.disposeAll()

    const ensureSync = disableWorkspaceSync()
    const proxyHttp = spyOn(ServerProxy, "http")

    try {
      const app = Server.Default().app
      const response = await app.request(`/session/${session.id}/message?workspace=${localWorkspace.id}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-opencode-directory": first.path,
        },
        body: JSON.stringify({}),
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ routed: "session-workspace" })
      expect(remoteHits).toBe(1)
      expect(proxyHttp).toHaveBeenCalledTimes(1)
      const call = proxyHttp.mock.calls[0] as unknown as [URL | string, HeadersInit | undefined, Request, unknown]
      expect(call[0].toString()).toBe(remote.url.origin)
      expect(call[3]).toBe(remoteWorkspace.id)
      expect(call[2].headers.has("x-opencode-workspace")).toBe(false)
    } finally {
      ensureSync.mockRestore()
      proxyHttp.mockRestore()
    }
  })

  test("routes remote workspace websocket upgrades through the websocket proxy", async () => {
    const target = "http://127.0.0.1:9"
    await using tmp = await tmpdir({
      init: (dir) => writeRemoteWorkspacePlugin({ dir, url: target }),
    })
    const workspace = await persistRemoteWorkspace({ directory: tmp.path, type: tmp.extra.type })
    await Instance.disposeAll()

    const ensureSync = disableWorkspaceSync()
    const websocket = spyOn(ServerProxy, "websocket").mockImplementation(() => new Response("websocket-proxy"))

    try {
      const app = Server.Default().app
      const response = await app.request(`/pty/pty_test/connect?workspace=${workspace.id}`, {
        headers: {
          connection: "upgrade",
          upgrade: "websocket",
          "x-opencode-directory": tmp.path,
        },
      })

      expect(response.status).toBe(200)
      expect(await response.text()).toBe("websocket-proxy")
      expect(websocket).toHaveBeenCalledTimes(1)
      const call = websocket.mock.calls[0] as unknown as [unknown, { type?: string; url?: string }, Request]
      const proxiedTarget = call[1]
      const proxiedRequest = call[2]
      const proxiedURL = new URL(proxiedRequest.url)
      expect(proxiedTarget).toEqual({ type: "remote", url: target })
      expect(proxiedURL.pathname).toBe("/pty/pty_test/connect")
      expect(proxiedURL.searchParams.get("workspace")).toBe(workspace.id)
      expect(proxiedRequest.headers.get("upgrade")).toBe("websocket")
      expect(proxiedRequest.headers.get("connection")).toBe("upgrade")
    } finally {
      ensureSync.mockRestore()
      websocket.mockRestore()
    }
  })

  test("keeps remote target failures in the Effect failure channel and Hono error response", async () => {
    const message = "workspace target failed"
    await using tmp = await tmpdir({
      init: (dir) => writeRemoteWorkspacePlugin({ dir, url: "http://127.0.0.1:9", targetError: message }),
    })
    const workspace = await persistRemoteWorkspace({ directory: tmp.path, type: tmp.extra.type })
    await Instance.disposeAll()

    const ensureSync = disableWorkspaceSync()

    try {
      const exit = await AppRuntime.runPromiseExit(
        resolveWorkspaceRoute({
          method: "GET",
          pathname: "/path",
          directory: tmp.path,
          workspaceID: workspace.id,
          ensureConfig: false,
          isPawWork: true,
        }),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasFails(exit.cause)).toBe(true)
        expect(Cause.hasDies(exit.cause)).toBe(false)
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(WorkspaceRoutingError)
        expect((error as WorkspaceRoutingError).reason).toBe("workspace-target")
        expect((error as WorkspaceRoutingError).message).toContain(message)
      }

      const response = await Server.Default().app.request(`/path?workspace=${workspace.id}`, {
        headers: {
          "x-opencode-directory": tmp.path,
        },
      })
      const body = await response.json()

      expect(response.status).toBe(500)
      expect(body.name).toBe("UnknownError")
      // The Effect failure channel above still carries the real message; the HTTP body is
      // redacted to a constant so the internal failure never leaks to clients (ErrorMiddleware).
      expect(body.data.message).toBe("Unexpected server error. Check server logs for details.")
      expect(JSON.stringify(body)).not.toContain(message)
    } finally {
      ensureSync.mockRestore()
    }
  })

  test("keeps malformed remote targets in the Effect failure channel", async () => {
    await using tmp = await tmpdir({
      init: (dir) => writeRemoteWorkspacePlugin({ dir, url: "http://127.0.0.1:9", targetValue: "undefined" }),
    })
    const workspace = await persistRemoteWorkspace({ directory: tmp.path, type: tmp.extra.type })
    await Instance.disposeAll()

    const ensureSync = disableWorkspaceSync()

    try {
      const exit = await AppRuntime.runPromiseExit(
        resolveWorkspaceRoute({
          method: "GET",
          pathname: "/path",
          directory: tmp.path,
          workspaceID: workspace.id,
          ensureConfig: false,
          isPawWork: true,
        }),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasFails(exit.cause)).toBe(true)
        expect(Cause.hasDies(exit.cause)).toBe(false)
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(WorkspaceRoutingError)
        expect((error as WorkspaceRoutingError).reason).toBe("workspace-target")
      }
    } finally {
      ensureSync.mockRestore()
    }
  })

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
    const firstSpace = path.join(first.path, "first-space")
    const secondSpace = path.join(second.path, "second-space")
    await writeLocalWorkspacePlugin({ dir: first.path, name: "first", directory: firstSpace, type })
    await writeLocalWorkspacePlugin({ dir: second.path, name: "second", directory: secondSpace, type })

    const workspace = await createLocalWorkspace({ directory: first.path, type })

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
      init: (dir) => writeRemoteWorkspacePlugin({ dir, url: remote.url.origin, branch: "remote/main" }),
    })

    const workspace = await persistRemoteWorkspace({ directory: tmp.path, type: tmp.extra.type, branch: "remote/main" })

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
