import { describe, expect, test } from "bun:test"
import { base64Encode } from "@opencode-ai/util/encode"
import { promptScopeForSession } from "./prompt-route-scope"

describe("prompt route scope", () => {
  test("uses current route slug when execution target is current route directory", () => {
    expect(
      promptScopeForSession({
        routeDir: "route-repo",
        routeDirectory: "/repo",
        targetDirectory: "/repo",
        sessionID: "ses_1",
      }),
    ).toEqual({ dir: "route-repo", id: "ses_1" })
  })

  test("uses encoded target directory for new worktree session", () => {
    expect(
      promptScopeForSession({
        routeDir: "route-repo",
        routeDirectory: "/repo",
        targetDirectory: "/repo-worktree",
        sessionID: "ses_2",
      }),
    ).toEqual({ dir: base64Encode("/repo-worktree"), id: "ses_2" })
  })

  test("uses encoded target directory when route is missing", () => {
    expect(
      promptScopeForSession({
        routeDir: undefined,
        routeDirectory: undefined,
        targetDirectory: "/repo",
        sessionID: "ses_3",
      }),
    ).toEqual({ dir: base64Encode("/repo"), id: "ses_3" })
  })
})
