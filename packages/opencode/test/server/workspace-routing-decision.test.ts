import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import {
  classifyWorkspaceRoute,
  resolveWorkspaceRoute,
  sessionIDForWorkspaceRouting,
  shouldCreateLegacyConfigBeforeNoWorkspacePath,
} from "../../src/server/instance/workspace-routing"

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
      }),
    )

    expect(decision).toEqual({
      action: "provide-local-context",
      directory,
      createLegacyConfig: true,
    })
  })
})
