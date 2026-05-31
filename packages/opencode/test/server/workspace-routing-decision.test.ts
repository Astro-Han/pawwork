import { describe, expect, test } from "bun:test"
import {
  classifyWorkspaceRoute,
  sessionIDForWorkspaceRouting,
  shouldCreateLegacyConfigBeforePath,
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

  test("detects workspace session ids without treating status or e2e routes as session-bound", () => {
    expect(sessionIDForWorkspaceRouting("/session/ses_1/message")?.toString()).toBe("ses_1")
    expect(sessionIDForWorkspaceRouting("/session/status")).toBeUndefined()
    expect(sessionIDForWorkspaceRouting("/session/__e2e/create")).toBeUndefined()
    expect(sessionIDForWorkspaceRouting("/path")).toBeUndefined()
  })

  test("keeps legacy config precreation scoped to OpenCode no-workspace path requests", () => {
    expect(
      shouldCreateLegacyConfigBeforePath({
        pathname: "/path",
        ensureConfig: true,
        hasWorkspace: false,
        isPawWork: false,
      }),
    ).toBe(true)
    expect(
      shouldCreateLegacyConfigBeforePath({
        pathname: "/path",
        ensureConfig: true,
        hasWorkspace: true,
        isPawWork: false,
      }),
    ).toBe(false)
    expect(
      shouldCreateLegacyConfigBeforePath({
        pathname: "/path",
        ensureConfig: true,
        hasWorkspace: false,
        isPawWork: true,
      }),
    ).toBe(false)
  })
})
