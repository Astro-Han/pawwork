import { describe, expect, test } from "bun:test"
import { base64Encode } from "@opencode-ai/util/encode"
import { createShellNavigation } from "./shell-navigation"

describe("createShellNavigation", () => {
  test("opens a new session through one shell action and releases transient locks first", () => {
    const calls: string[] = []
    const shell = createShellNavigation({
      navigate: (route) => calls.push(`navigate:${route}`),
      releaseTransientLocks: (reason) => calls.push(`release:${reason}`),
      resolveProjectRoot: (directory) => `/root:${directory}`,
      currentProjectRoot: () => "/current",
      chooseProject: () => calls.push("chooseProject"),
      openSettingsSurface: () => calls.push("settings"),
    })

    shell.openNewSession("/repo")

    expect(calls).toEqual([`release:new-session`, `navigate:/${base64Encode("/root:/repo")}/session`])
  })

  test("opens an existing session through one shell action and releases transient locks first", () => {
    const calls: string[] = []
    const shell = createShellNavigation({
      navigate: (route) => calls.push(`navigate:${route}`),
      releaseTransientLocks: (reason) => calls.push(`release:${reason}`),
      resolveProjectRoot: (directory) => directory,
      currentProjectRoot: () => "/current",
      chooseProject: () => calls.push("chooseProject"),
      openSettingsSurface: () => calls.push("settings"),
    })

    shell.openSession({ directory: "/repo", id: "ses_123" })

    expect(calls).toEqual([`release:session`, `navigate:/${base64Encode("/repo")}/session/ses_123`])
  })

  test("opens settings through the same shell action owner instead of a standalone signal", () => {
    const calls: string[] = []
    const shell = createShellNavigation({
      navigate: (route) => calls.push(`navigate:${route}`),
      releaseTransientLocks: (reason) => calls.push(`release:${reason}`),
      resolveProjectRoot: (directory) => directory,
      currentProjectRoot: () => "/current",
      chooseProject: () => calls.push("chooseProject"),
      openSettingsSurface: () => calls.push("settings"),
    })

    shell.openSettings()

    expect(calls).toEqual(["release:settings", "settings"])
  })

  test("falls back to project chooser when no directory can be resolved for a new session", () => {
    const calls: string[] = []
    const shell = createShellNavigation({
      navigate: (route) => calls.push(`navigate:${route}`),
      releaseTransientLocks: (reason) => calls.push(`release:${reason}`),
      resolveProjectRoot: () => "",
      currentProjectRoot: () => undefined,
      chooseProject: () => calls.push("chooseProject"),
      openSettingsSurface: () => calls.push("settings"),
    })

    shell.openNewSession()

    expect(calls).toEqual(["release:choose-project", "chooseProject"])
  })

  test("falls back to project chooser when an explicit directory cannot be resolved", () => {
    const calls: string[] = []
    const shell = createShellNavigation({
      navigate: (route) => calls.push(`navigate:${route}`),
      releaseTransientLocks: (reason) => calls.push(`release:${reason}`),
      resolveProjectRoot: () => undefined,
      currentProjectRoot: () => "/current",
      chooseProject: () => calls.push("chooseProject"),
      openSettingsSurface: () => calls.push("settings"),
    })

    shell.openNewSession("/repo")

    expect(calls).toEqual(["release:choose-project", "chooseProject"])
  })
})
