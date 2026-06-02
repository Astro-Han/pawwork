import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { base64Encode } from "@opencode-ai/util/encode"
import type { Session } from "@opencode-ai/sdk/v2/client"
import {
  createPawworkWorkspaceLifecycle,
  type PawworkWorkspaceLifecycleInput,
} from "./pawwork-workspace-lifecycle"

type Calls = {
  navigate: string[]
  setStore: unknown[][]
  setBusy: [string, boolean][]
  setWorkspaceName: unknown[][]
  globalSyncSet: unknown[]
  globalSyncChild: string[]
  projectsClose: string[]
  projectsOpen: string[]
  toggleWorkspaces: string[]
  worktreeCreate: unknown[]
  worktreeRemove: unknown[]
  worktreeReset: unknown[]
  sessionUpdate: unknown[][]
  dispose: unknown[]
  clearTerminals: unknown[][]
  // Cross-call ordering so tests can pin "navigate-before-remove" etc.
  order: string[]
}

type SetupOpts = {
  createResult?: { directory: string; branch: string } | "reject"
  removeResult?: boolean | "reject"
  resetResult?: boolean | "reject"
  sessions?: Session[]
  currentDir?: string
  paramsDir?: string
  currentProject?: unknown
  workspaceOrder?: Record<string, string[]>
  workspaceNameValue?: string | undefined
}

function makeProject(over: Record<string, unknown> = {}) {
  return { worktree: "/repo", id: "p1", vcs: "git", sandboxes: [], ...over }
}

function setup(opts: SetupOpts = {}) {
  const calls: Calls = {
    navigate: [],
    setStore: [],
    setBusy: [],
    setWorkspaceName: [],
    globalSyncSet: [],
    globalSyncChild: [],
    projectsClose: [],
    projectsOpen: [],
    toggleWorkspaces: [],
    worktreeCreate: [],
    worktreeRemove: [],
    worktreeReset: [],
    sessionUpdate: [],
    dispose: [],
    clearTerminals: [],
    order: [],
  }
  const store = {
    workspaceOrder: opts.workspaceOrder ?? {},
  }
  const input = {
    globalSDK: {
      client: {
        worktree: {
          create: (args: unknown) => {
            calls.worktreeCreate.push(args)
            calls.order.push("worktree.create")
            if (opts.createResult === "reject") return Promise.reject(new Error("create failed"))
            return Promise.resolve({ data: opts.createResult ?? { directory: "/repo/.wt/feat", branch: "feat" } })
          },
          remove: (args: unknown) => {
            calls.worktreeRemove.push(args)
            calls.order.push("worktree.remove")
            if (opts.removeResult === "reject") return Promise.reject(new Error("remove failed"))
            return Promise.resolve({ data: opts.removeResult ?? true })
          },
          reset: (args: unknown) => {
            calls.worktreeReset.push(args)
            calls.order.push("worktree.reset")
            if (opts.resetResult === "reject") return Promise.reject(new Error("reset failed"))
            return Promise.resolve({ data: opts.resetResult ?? true })
          },
        },
        session: {
          list: () => Promise.resolve({ data: opts.sessions ?? [] }),
          update: (args: unknown) => {
            calls.sessionUpdate.push([args])
            return Promise.resolve({ data: {} })
          },
        },
      },
      createClient: () => ({
        instance: {
          dispose: (args: unknown) => {
            calls.dispose.push(args)
            calls.order.push("dispose")
            return Promise.resolve({ data: {} })
          },
        },
      }),
    },
    globalSync: {
      child: (directory: string) => {
        calls.globalSyncChild.push(directory)
        return [{}] as never
      },
      set: (...args: unknown[]) => {
        calls.globalSyncSet.push(args)
      },
    },
    layout: {
      projects: {
        close: (directory: string) => {
          calls.projectsClose.push(directory)
          calls.order.push(`close:${directory}`)
        },
        open: (directory: string) => {
          calls.projectsOpen.push(directory)
          calls.order.push(`open:${directory}`)
        },
        list: () => [makeProject()],
      },
      sidebar: {
        workspaces: () => () => true,
        toggleWorkspaces: (directory: string) => calls.toggleWorkspaces.push(directory),
      },
    },
    platform: {},
    clearWorkspaceTerminals: (...args: unknown[]) => {
      calls.clearTerminals.push(args)
      calls.order.push("clearTerminals")
    },
    store,
    setStore: (...args: unknown[]) => calls.setStore.push(args),
    navigate: (href: string) => {
      calls.navigate.push(href)
      calls.order.push(`navigate:${href}`)
    },
    language: { t: (key: string) => key },
    params: { dir: opts.paramsDir },
    setBusy: (directory: string, value: boolean) => {
      calls.setBusy.push([directory, value])
      calls.order.push(`busy:${directory}:${value}`)
    },
    currentDir: () => opts.currentDir ?? "",
    currentProject: () => opts.currentProject as never,
    projectRoot: (directory: string) => directory,
    setWorkspaceName: (...args: unknown[]) => calls.setWorkspaceName.push(args),
    workspaceName: () => opts.workspaceNameValue,
  } as unknown as PawworkWorkspaceLifecycleInput
  return { input, calls, store }
}

describe("createPawworkWorkspaceLifecycle", () => {
  test("renameWorkspace skips the write when the name is unchanged", () => {
    createRoot((dispose) => {
      const { input, calls } = setup({ workspaceNameValue: "same" })
      const actions = createPawworkWorkspaceLifecycle(input)
      actions.renameWorkspace("/repo/wt", "same", "p1", "feat")
      expect(calls.setWorkspaceName).toEqual([])
      dispose()
    })
  })

  test("renameWorkspace writes all four args when the name changes", () => {
    createRoot((dispose) => {
      const { input, calls } = setup({ workspaceNameValue: "old" })
      const actions = createPawworkWorkspaceLifecycle(input)
      actions.renameWorkspace("/repo/wt", "new", "p1", "feat")
      expect(calls.setWorkspaceName).toEqual([["/repo/wt", "new", "p1", "feat"]])
      dispose()
    })
  })

  test("createWorkspace names the worktree, dedups the order, syncs the child, and navigates", async () => {
    await createRoot(async (dispose) => {
      const { input, calls } = setup({
        createResult: { directory: "/repo/.wt/feat", branch: "feat" },
        workspaceOrder: { "/repo": ["/repo", "/repo/.wt/feat", "/repo/other"] },
      })
      const actions = createPawworkWorkspaceLifecycle(input)
      await actions.createWorkspace(makeProject() as never)

      expect(calls.setWorkspaceName).toEqual([["/repo/.wt/feat", "feat", "p1", "feat"]])
      expect(calls.globalSyncChild).toEqual(["/repo/.wt/feat"])
      expect(calls.navigate).toEqual([`/${base64Encode("/repo/.wt/feat")}/session`])

      // workspaceOrder updater dedups the created dir + root, prepends created.
      const orderCall = calls.setStore.find((c) => c[0] === "workspaceOrder")
      expect(orderCall?.[1]).toBe("/repo")
      const updater = orderCall?.[2] as (prev: string[]) => string[]
      expect(updater(["/repo", "/repo/.wt/feat", "/repo/other"])).toEqual(["/repo/.wt/feat", "/repo/other"])
      dispose()
    })
  })

  test("createWorkspace aborts cleanly when the worktree create fails", async () => {
    await createRoot(async (dispose) => {
      const { input, calls } = setup({ createResult: "reject" })
      const actions = createPawworkWorkspaceLifecycle(input)
      await actions.createWorkspace(makeProject() as never)
      expect(calls.setWorkspaceName).toEqual([])
      expect(calls.globalSyncChild).toEqual([])
      expect(calls.navigate).toEqual([])
      dispose()
    })
  })

  test("deleteWorkspace is a no-op when directory equals root", async () => {
    await createRoot(async (dispose) => {
      const { input, calls } = setup()
      const actions = createPawworkWorkspaceLifecycle(input)
      await actions.deleteWorkspace("/repo", "/repo")
      expect(calls.worktreeRemove).toEqual([])
      expect(calls.setBusy).toEqual([])
      dispose()
    })
  })

  test("deleteWorkspace on success removes, prunes order, and reopens the root", async () => {
    await createRoot(async (dispose) => {
      const { input, calls } = setup({
        currentDir: "/repo",
        workspaceOrder: { "/repo": ["/repo", "/repo/.wt/feat"] },
      })
      const actions = createPawworkWorkspaceLifecycle(input)
      await actions.deleteWorkspace("/repo", "/repo/.wt/feat")

      expect(calls.worktreeRemove).toEqual([{ directory: "/repo", worktreeRemoveInput: { directory: "/repo/.wt/feat" } }])
      expect(calls.globalSyncSet.length).toBe(1)
      expect(calls.projectsClose).toEqual(["/repo/.wt/feat"])
      expect(calls.projectsOpen).toEqual(["/repo"])
      const orderCall = calls.setStore.find((c) => c[0] === "workspaceOrder")
      const updater = orderCall?.[2] as (prev: string[]) => string[]
      expect(updater(["/repo", "/repo/.wt/feat"])).toEqual(["/repo"])
      dispose()
    })
  })

  test("deleteWorkspace navigates away BEFORE removing when deleting the active workspace", async () => {
    await createRoot(async (dispose) => {
      const { input, calls } = setup({ currentDir: "/repo/.wt/feat", paramsDir: "slug" })
      const actions = createPawworkWorkspaceLifecycle(input)
      await actions.deleteWorkspace("/repo", "/repo/.wt/feat")
      const navIndex = calls.order.indexOf(`navigate:/${base64Encode("/repo")}/session`)
      const removeIndex = calls.order.indexOf("worktree.remove")
      expect(navIndex).toBeGreaterThanOrEqual(0)
      expect(navIndex).toBeLessThan(removeIndex)
      dispose()
    })
  })

  test("deleteWorkspace on remove failure does not mutate or close", async () => {
    await createRoot(async (dispose) => {
      const { input, calls } = setup({ currentDir: "/repo", removeResult: "reject" })
      const actions = createPawworkWorkspaceLifecycle(input)
      await actions.deleteWorkspace("/repo", "/repo/.wt/feat")
      expect(calls.globalSyncSet).toEqual([])
      expect(calls.projectsClose).toEqual([])
      // setBusy was toggled true then false around the failed request.
      expect(calls.setBusy).toEqual([
        ["/repo/.wt/feat", true],
        ["/repo/.wt/feat", false],
      ])
      dispose()
    })
  })

  test("resetWorkspace disposes, resets, and archives only un-archived sessions", async () => {
    const sessions = [
      { id: "s1", directory: "/repo/.wt/feat", time: { archived: undefined } },
      { id: "s2", directory: "/repo/.wt/feat", time: { archived: 123 } },
    ] as unknown as Session[]
    await createRoot(async (dispose) => {
      const { input, calls } = setup({ resetResult: true, sessions })
      const actions = createPawworkWorkspaceLifecycle(input)
      await actions.resetWorkspace("/repo", "/repo/.wt/feat")

      // Terminals are cleared with all session ids before the dispose/reset.
      expect(calls.clearTerminals).toEqual([["/repo/.wt/feat", ["s1", "s2"], {}]])
      expect(calls.order.indexOf("clearTerminals")).toBeLessThan(calls.order.indexOf("dispose"))
      expect(calls.order.indexOf("dispose")).toBeLessThan(calls.order.indexOf("worktree.reset"))
      expect(calls.dispose).toEqual([{ directory: "/repo/.wt/feat" }])
      expect(calls.worktreeReset).toEqual([{ directory: "/repo", worktreeResetInput: { directory: "/repo/.wt/feat" } }])
      // Only s1 (archived === undefined) gets an update.
      expect(calls.sessionUpdate.length).toBe(1)
      expect((calls.sessionUpdate[0][0] as { sessionID: string }).sessionID).toBe("s1")
      // Busy is set true at start and cleared on success.
      expect(calls.setBusy).toEqual([
        ["/repo/.wt/feat", true],
        ["/repo/.wt/feat", false],
      ])
      dispose()
    })
  })

  test("resetWorkspace on reset failure clears busy and archives nothing", async () => {
    const sessions = [
      { id: "s1", directory: "/repo/.wt/feat", time: { archived: undefined } },
    ] as unknown as Session[]
    await createRoot(async (dispose) => {
      const { input, calls } = setup({ resetResult: "reject", sessions })
      const actions = createPawworkWorkspaceLifecycle(input)
      await actions.resetWorkspace("/repo", "/repo/.wt/feat")
      expect(calls.sessionUpdate).toEqual([])
      expect(calls.setBusy).toEqual([
        ["/repo/.wt/feat", true],
        ["/repo/.wt/feat", false],
      ])
      dispose()
    })
  })

  test("toggleCurrentWorkspace toggles a git project and returns the prior enabled state", () => {
    createRoot((dispose) => {
      const { input, calls } = setup({ currentProject: makeProject({ vcs: "git" }) })
      const actions = createPawworkWorkspaceLifecycle(input)
      expect(actions.toggleCurrentWorkspace()).toBe(true)
      expect(calls.toggleWorkspaces).toEqual(["/repo"])
      dispose()
    })
  })

  test("toggleCurrentWorkspace is a no-op for a non-git project", () => {
    createRoot((dispose) => {
      const { input, calls } = setup({ currentProject: makeProject({ vcs: "none" }) })
      const actions = createPawworkWorkspaceLifecycle(input)
      expect(actions.toggleCurrentWorkspace()).toBeUndefined()
      expect(calls.toggleWorkspaces).toEqual([])
      dispose()
    })
  })

  test("createCurrentWorkspace creates for the current project and no-ops without one", async () => {
    await createRoot(async (dispose) => {
      const withProject = setup({ currentProject: makeProject() })
      const a1 = createPawworkWorkspaceLifecycle(withProject.input)
      await a1.createCurrentWorkspace()
      expect(withProject.calls.worktreeCreate.length).toBe(1)

      const without = setup({ currentProject: undefined })
      const a2 = createPawworkWorkspaceLifecycle(without.input)
      await a2.createCurrentWorkspace()
      expect(without.calls.worktreeCreate).toEqual([])
      dispose()
    })
  })
})
