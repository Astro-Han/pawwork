import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Workspace } from "../../src/control-plane/workspace"
import { WorkspaceID } from "../../src/control-plane/schema"
import { ProjectID } from "../../src/project/schema"
import { Session } from "../../src/session"
import { SessionID } from "../../src/session/schema"
import {
  classifyWorkspaceRoute,
  resolveWorkspaceRoute,
  sessionIDForWorkspaceRouting,
  shouldCreateLegacyConfigBeforeNoWorkspacePath,
} from "../../src/server/instance/workspace-routing"

const unusedSessionService = Session.Service.of({
  get: () => Effect.die("unexpected session lookup"),
} as unknown as Session.Service["Service"])

describe("workspace routing decisions", () => {
  test("keeps session status remote while treating GET session routes as local cached routes", () => {
    expect(classifyWorkspaceRoute({ method: "GET", pathname: "/session/status", target: "remote" })).toEqual({
      action: "proxy-http",
    })
    expect(classifyWorkspaceRoute({ method: "GET", pathname: "/session", target: "remote" })).toEqual({
      action: "serve-local-cache",
    })
    expect(classifyWorkspaceRoute({ method: "GET", pathname: "/session/ses_1", target: "remote" })).toEqual({
      action: "serve-local-cache",
    })
    expect(classifyWorkspaceRoute({ method: "POST", pathname: "/session/ses_1/message", target: "remote" })).toEqual(
      {
        action: "proxy-http",
      },
    )
  })

  test("routes missing workspace deletes through while other missing records fail explicitly", () => {
    expect(classifyWorkspaceRoute({ method: "DELETE", pathname: "/session/ses_missing", target: "missing" })).toEqual({
      action: "pass-missing-session-delete",
    })
    expect(classifyWorkspaceRoute({ method: "GET", pathname: "/path", target: "missing" })).toEqual({
      action: "missing-workspace-error",
    })
  })

  test("provides local workspace targets and keeps remote websocket upgrades on the proxy path", () => {
    expect(classifyWorkspaceRoute({ method: "GET", pathname: "/path", target: "local" })).toEqual({
      action: "provide-local-workspace",
    })
    expect(
      classifyWorkspaceRoute({
        method: "GET",
        pathname: "/pty/pty_1/connect",
        target: "remote",
        isWebSocketUpgrade: true,
      }),
    ).toEqual({
      action: "proxy-websocket",
    })
  })

  test("keeps cached remote GET session routes before websocket proxy routing", () => {
    expect(
      classifyWorkspaceRoute({
        method: "GET",
        pathname: "/session",
        target: "remote",
        isWebSocketUpgrade: true,
      }),
    ).toEqual({
      action: "serve-local-cache",
    })
    expect(
      classifyWorkspaceRoute({
        method: "GET",
        pathname: "/session/ses_1",
        target: "remote",
        isWebSocketUpgrade: true,
      }),
    ).toEqual({
      action: "serve-local-cache",
    })
  })

  test("detects workspace session ids without treating status or e2e routes as session-bound", () => {
    expect(sessionIDForWorkspaceRouting("/session/ses_1/message")?.toString()).toBe("ses_1")
    expect(sessionIDForWorkspaceRouting("/session/status")).toBeUndefined()
    expect(sessionIDForWorkspaceRouting("/session/__e2e/create")).toBeUndefined()
    expect(sessionIDForWorkspaceRouting("/path")).toBeUndefined()
  })

  test("keeps legacy config precreation scoped to OpenCode no-workspace path requests", () => {
    expect(
      shouldCreateLegacyConfigBeforeNoWorkspacePath({
        pathname: "/path",
        ensureConfig: true,
        isPawWork: false,
      }),
    ).toBe(true)
    expect(
      shouldCreateLegacyConfigBeforeNoWorkspacePath({
        pathname: "/path",
        ensureConfig: true,
        isPawWork: true,
      }),
    ).toBe(false)
  })

  test("resolves no-workspace routes through an Effect route decision", async () => {
    const directory = "/tmp/pawwork-effect-router"
    const decision = await Effect.runPromise(
      resolveWorkspaceRoute({
        method: "GET",
        pathname: "/path",
        directory,
        workspaceID: undefined,
        ensureConfig: true,
        isPawWork: false,
      }).pipe(Effect.provide(Workspace.defaultLayer), Effect.provideService(Session.Service, unusedSessionService)),
    )

    expect(decision).toEqual({
      action: "provide-local-context",
      directory,
      createLegacyConfig: true,
    })
  })

  test("resolves workspace routes through the injected Workspace service", async () => {
    const id = WorkspaceID.make("ws_effect_router")
    const requestDirectory = "/tmp/pawwork-effect-request"
    const targetDirectory = "/tmp/pawwork-effect-target"
    const calls: string[] = []

    const decision = await Effect.runPromise(
      resolveWorkspaceRoute({
        method: "GET",
        pathname: "/path",
        directory: requestDirectory,
        workspaceID: id,
        ensureConfig: false,
        isPawWork: true,
      }).pipe(
        Effect.provideService(
          Workspace.Service,
          Workspace.Service.of({
            create: () => Effect.die("unexpected create"),
            list: () => Effect.die("unexpected list"),
            record: (workspaceID) =>
              Effect.sync(() => {
                calls.push(`record:${workspaceID}`)
                return {
                  id: workspaceID,
                  type: "test",
                  branch: null,
                  name: null,
                  directory: null,
                  owner: null,
                  extra: null,
                  projectID: ProjectID.global,
                }
              }),
            get: () => Effect.die("unexpected get"),
            ensureSync: (space, hint) =>
              Effect.sync(() => {
                if (!space) throw new Error("expected workspace")
                calls.push(`ensureSync:${space.id}:${hint}`)
              }),
            remove: () => Effect.die("unexpected remove"),
            resolveAdaptor: (space) =>
              Effect.sync(() => {
                calls.push(`resolveAdaptor:${id}:${space.type}`)
                return {
                  configure: (input) => input,
                  create: async () => {},
                  remove: async () => {},
                  target: () => ({ type: "local" as const, directory: targetDirectory }),
                }
              }),
            status: () => Effect.succeed([]),
          }),
        ),
        Effect.provideService(Session.Service, unusedSessionService),
      ),
    )

    expect(decision).toEqual({
      action: "provide-local-context",
      directory: targetDirectory,
      workspaceID: id,
    })
    expect(calls).toEqual([
      `record:${id}`,
      `ensureSync:${id}:${requestDirectory}`,
      `resolveAdaptor:${id}:test`,
    ])
  })

  test("resolves session-bound workspaces through the injected Session service", async () => {
    const sessionID = SessionID.make("ses_effect_router")
    const sessionWorkspaceID = WorkspaceID.make("ws_session_router")
    const queryWorkspaceID = WorkspaceID.make("ws_query_router")
    const requestDirectory = "/tmp/pawwork-effect-request"
    const localDirectory = "/tmp/pawwork-effect-local"
    const calls: string[] = []

    const decision = await Effect.runPromise(
      resolveWorkspaceRoute({
        method: "POST",
        pathname: `/session/${sessionID}/message`,
        directory: requestDirectory,
        workspaceID: queryWorkspaceID,
        ensureConfig: false,
        isPawWork: true,
      }).pipe(
        Effect.provideService(
          Session.Service,
          Session.Service.of({
            get: (id: SessionID) =>
              Effect.sync(() => {
                calls.push(`session:${id}`)
                return { workspaceID: sessionWorkspaceID }
              }),
          } as unknown as Session.Service["Service"]),
        ),
        Effect.provideService(
          Workspace.Service,
          Workspace.Service.of({
            create: () => Effect.die("unexpected create"),
            list: () => Effect.die("unexpected list"),
            record: (workspaceID) =>
              Effect.sync(() => {
                calls.push(`record:${workspaceID}`)
                return {
                  id: workspaceID,
                  type: workspaceID === sessionWorkspaceID ? "remote-test" : "local-test",
                  branch: null,
                  name: null,
                  directory: null,
                  owner: null,
                  extra: null,
                  projectID: ProjectID.global,
                }
              }),
            get: () => Effect.die("unexpected get"),
            ensureSync: (space, hint) =>
              Effect.sync(() => {
                if (!space) throw new Error("expected workspace")
                calls.push(`ensureSync:${space.id}:${hint}`)
              }),
            remove: () => Effect.die("unexpected remove"),
            resolveAdaptor: (space) =>
              Effect.sync(() => {
                calls.push(`resolveAdaptor:${space.projectID}:${space.type}`)
                return {
                  configure: (input) => input,
                  create: async () => {},
                  remove: async () => {},
                  target: () =>
                    space.type === "remote-test"
                      ? { type: "remote" as const, url: "http://remote.example" }
                      : { type: "local" as const, directory: localDirectory },
                }
              }),
            status: () => Effect.succeed([]),
          }),
        ),
      ),
    )

    expect(decision).toEqual({
      action: "proxy-http",
      target: { type: "remote", url: "http://remote.example" },
      workspaceID: sessionWorkspaceID,
    })
    expect(calls).toContain(`session:${sessionID}`)
    expect(calls).toContain(`record:${sessionWorkspaceID}`)
    expect(calls).not.toContain(`record:${queryWorkspaceID}`)
  })
})
