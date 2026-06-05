import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { base64Encode } from "@opencode-ai/util/encode"
import { createPawworkRoutingActions, type PawworkRoutingActionsInput } from "./pawwork-routing-actions"

type Calls = {
  navigate: string[]
  setStore: unknown[][]
  touch: string[]
  markViewed: string[]
  scrollToSession: [string, string][]
  adopt: unknown[]
  openSession: unknown[]
  openNewSession: (string | undefined)[]
  projectsOpen: string[]
}

function setup(storeOverride: { workspaceExpanded?: Record<string, boolean> } = {}) {
  const calls: Calls = {
    navigate: [],
    setStore: [],
    touch: [],
    markViewed: [],
    scrollToSession: [],
    adopt: [],
    openSession: [],
    openNewSession: [],
    projectsOpen: [],
  }
  const store = {
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
    // Resolved root differs from the input directory so tests can prove the
    // new-session slug is built from the original directory, not the root.
    projectRoot: (directory: string) => `/resolved${directory}`,
    activeProjectRoot: (directory: string) => `root:${directory}`,
    shellNavigation: {
      openSession: (session: unknown) => calls.openSession.push(session),
      openNewSession: (directory: string | undefined) => calls.openNewSession.push(directory),
    },
    layout: { projects: { open: (directory: string) => calls.projectsOpen.push(directory) } },
  } as unknown as PawworkRoutingActionsInput
  return { input, calls, store }
}

describe("createPawworkRoutingActions", () => {
  test("navigateToSession opens the session", () => {
    createRoot((dispose) => {
      const { input, calls } = setup()
      const actions = createPawworkRoutingActions(input)
      const session = { id: "s1", directory: "/repo" }
      actions.navigateToSession(session as never)
      expect(calls.openSession).toEqual([session])
      dispose()
    })
  })

  test("openPawworkHome opens a new session for the directory", () => {
    createRoot((dispose) => {
      const { input, calls } = setup()
      const actions = createPawworkRoutingActions(input)
      actions.openPawworkHome("/repo")
      expect(calls.openNewSession).toEqual(["/repo"])
      dispose()
    })
  })

  test("syncSessionRoute returns root, marks viewed, expands the directory, and schedules the scroll via rAF", () => {
    const originalRAF = globalThis.requestAnimationFrame
    // Run the rAF callback synchronously so the scheduled scroll is observable;
    // this pins the RAF/untrack ordering that a naive refactor could drop.
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(0)
      return 0
    }) as typeof requestAnimationFrame
    try {
      createRoot((dispose) => {
        const { input, calls } = setup({ workspaceExpanded: { "/repo": false } })
        const actions = createPawworkRoutingActions(input)
        expect(actions.syncSessionRoute("/repo", "s1")).toBe("root:/repo")
        expect(calls.markViewed).toEqual(["s1"])
        expect(calls.setStore).toContainEqual(["workspaceExpanded", "/repo", true])
        expect(calls.scrollToSession).toEqual([["s1", "/repo:s1"]])
        dispose()
      })
    } finally {
      globalThis.requestAnimationFrame = originalRAF
    }
  })

  test("syncSessionRoute honors an explicit root argument", () => {
    createRoot((dispose) => {
      const { input } = setup()
      const actions = createPawworkRoutingActions(input)
      expect(actions.syncSessionRoute("/repo", "s1", "explicit-root")).toBe("explicit-root")
      dispose()
    })
  })

  test("deep-link new-session opens the project without navigating, then navigates to the ORIGINAL directory slug (not the resolved root, not openPawworkHome)", () => {
    createRoot((dispose) => {
      const { input, calls } = setup()
      const actions = createPawworkRoutingActions(input)
      actions.handleDeepLinks(["opencode://new-session?directory=/repo&prompt=hello"])
      expect(calls.projectsOpen).toEqual(["/repo"])
      expect(calls.adopt).toEqual([{ directory: "/repo", prompt: "hello" }])
      // Original directory slug, NOT base64Encode(projectRoot("/repo")) === "/resolved/repo".
      expect(calls.navigate).toEqual([`/${base64Encode("/repo")}/session`])
      expect(calls.openNewSession).toEqual([])
      expect(calls.touch).toEqual([])
      dispose()
    })
  })

  test("deep-link open-project routes through openProject into navigateToProject (touches the resolved root)", () => {
    createRoot((dispose) => {
      const { input, calls } = setup()
      const actions = createPawworkRoutingActions(input)
      actions.handleDeepLinks(["opencode://open-project?directory=/repo"])
      expect(calls.projectsOpen).toEqual(["/repo"])
      expect(calls.touch).toEqual(["/resolved/repo"])
      dispose()
    })
  })
})
