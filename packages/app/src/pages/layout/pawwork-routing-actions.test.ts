import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { base64Encode } from "@opencode-ai/util/encode"
import { createPawworkRoutingActions, type PawworkRoutingActionsInput } from "./pawwork-routing-actions"

// syncSessionRoute schedules a scroll via requestAnimationFrame; keep it a no-op
// so the synchronous assertions below are not affected by the deferred callback.
globalThis.requestAnimationFrame ??= (() => 0) as typeof requestAnimationFrame

type Calls = {
  navigate: string[]
  setStore: unknown[][]
  touch: string[]
  markViewed: string[]
  scrollToSession: [string, string][]
  adopt: unknown[]
  openSession: unknown[]
  openNewSession: (string | undefined)[]
  unhideProject: string[]
  projectsOpen: string[]
}

function setup(
  storeOverride: { pawworkProjectHidden?: Record<string, boolean>; workspaceExpanded?: Record<string, boolean> } = {},
) {
  const calls: Calls = {
    navigate: [],
    setStore: [],
    touch: [],
    markViewed: [],
    scrollToSession: [],
    adopt: [],
    openSession: [],
    openNewSession: [],
    unhideProject: [],
    projectsOpen: [],
  }
  const store = {
    pawworkProjectHidden: storeOverride.pawworkProjectHidden ?? {},
    workspaceExpanded: storeOverride.workspaceExpanded ?? {},
  }
  const input = {
    navigate: (href: string) => calls.navigate.push(href),
    server: { isLocal: () => true, projects: { touch: (root: string) => calls.touch.push(root) } },
    store,
    setStore: (...args: unknown[]) => calls.setStore.push(args),
    notification: { session: { markViewed: (id: string) => calls.markViewed.push(id) } },
    scrollToSession: (id: string, key: string) => calls.scrollToSession.push([id, key]),
    pinned: { adopt: (draft: unknown) => calls.adopt.push(draft) },
    projectRoot: (directory: string) => directory,
    activeProjectRoot: (directory: string) => `root:${directory}`,
    shellNavigation: {
      openSession: (session: unknown) => calls.openSession.push(session),
      openNewSession: (directory: string | undefined) => calls.openNewSession.push(directory),
    },
    unhideProject: (key: string) => calls.unhideProject.push(key),
    projectKeyForSession: (session: { directory: string }) => session.directory,
    layout: { projects: { open: (directory: string) => calls.projectsOpen.push(directory) } },
  } as unknown as PawworkRoutingActionsInput
  return { input, calls, store }
}

describe("createPawworkRoutingActions", () => {
  test("navigateToSession unhides a hidden project before opening the session", () => {
    createRoot((dispose) => {
      const { input, calls } = setup({ pawworkProjectHidden: { "/repo": true } })
      const actions = createPawworkRoutingActions(input)
      const session = { id: "s1", directory: "/repo" }
      actions.navigateToSession(session as never)
      expect(calls.unhideProject).toEqual(["/repo"])
      expect(calls.openSession).toEqual([session])
      dispose()
    })
  })

  test("navigateToSession does not unhide a visible project", () => {
    createRoot((dispose) => {
      const { input, calls } = setup()
      const actions = createPawworkRoutingActions(input)
      actions.navigateToSession({ id: "s1", directory: "/repo" } as never)
      expect(calls.unhideProject).toEqual([])
      expect(calls.openSession).toHaveLength(1)
      dispose()
    })
  })

  test("openPawworkHome unhides a hidden directory before opening a new session", () => {
    createRoot((dispose) => {
      const { input, calls } = setup({ pawworkProjectHidden: { "/repo": true } })
      const actions = createPawworkRoutingActions(input)
      actions.openPawworkHome("/repo")
      expect(calls.unhideProject).toEqual(["/repo"])
      expect(calls.openNewSession).toEqual(["/repo"])
      dispose()
    })
  })

  test("syncSessionRoute returns the resolved root, marks viewed, and expands a collapsed directory", () => {
    createRoot((dispose) => {
      const { input, calls } = setup({ workspaceExpanded: { "/repo": false } })
      const actions = createPawworkRoutingActions(input)
      expect(actions.syncSessionRoute("/repo", "s1")).toBe("root:/repo")
      expect(calls.markViewed).toEqual(["s1"])
      expect(calls.setStore).toContainEqual(["workspaceExpanded", "/repo", true])
      dispose()
    })
  })

  test("syncSessionRoute honors an explicit root argument", () => {
    createRoot((dispose) => {
      const { input } = setup()
      const actions = createPawworkRoutingActions(input)
      expect(actions.syncSessionRoute("/repo", "s1", "explicit-root")).toBe("explicit-root")
      dispose()
    })
  })

  test("deep-link new-session opens the project without navigating, then navigates to the original slug (not openPawworkHome)", () => {
    createRoot((dispose) => {
      const { input, calls } = setup()
      const actions = createPawworkRoutingActions(input)
      actions.handleDeepLinks(["opencode://new-session?directory=/repo&prompt=hello"])
      expect(calls.projectsOpen).toEqual(["/repo"])
      expect(calls.adopt).toEqual([{ directory: "/repo", prompt: "hello" }])
      expect(calls.navigate).toEqual([`/${base64Encode("/repo")}/session`])
      expect(calls.openNewSession).toEqual([])
      expect(calls.touch).toEqual([])
      dispose()
    })
  })

  test("deep-link open-project routes through openProject into navigateToProject", () => {
    createRoot((dispose) => {
      const { input, calls } = setup()
      const actions = createPawworkRoutingActions(input)
      actions.handleDeepLinks(["opencode://open-project?directory=/repo"])
      expect(calls.projectsOpen).toEqual(["/repo"])
      expect(calls.touch).toEqual(["/repo"])
    })
  })
})
