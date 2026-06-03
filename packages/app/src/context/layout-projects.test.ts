import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createPawworkLayoutProjects, type PawworkLayoutProjectsInput } from "./layout-projects"

// Bun test resolves solid-js to the server build, where createEffect/onMount are
// no-ops. These tests therefore exercise only the pure paths reachable through
// the memos (rootFor, list, enrich), which the server build evaluates normally.
// Effect-driven behaviour (color assignment, icon override sync, sandbox
// routing) is preserved verbatim from layout.tsx and is covered by /codex review.

type Project = { id?: string; worktree: string; icon?: { url?: string; override?: string; color?: string }; name?: string }
type ChildStore = { project?: string; icon?: string; projectMeta?: { name?: string; commands?: { start?: string } } }

type SetupOpts = {
  serverProjects?: { worktree: string; expanded: boolean }[]
  dataProjects?: (Project & { sandboxes?: string[] })[]
  childStores?: Record<string, ChildStore>
  ready?: boolean
}

function setup(opts: SetupOpts = {}) {
  const input: PawworkLayoutProjectsInput = {
    globalSDK: {
      client: {
        project: {
          update: () => Promise.resolve({ data: {} }),
        },
      },
    } as unknown as PawworkLayoutProjectsInput["globalSDK"],
    globalSync: {
      child: (worktree: string) => {
        const value = opts.childStores?.[worktree] ?? {}
        return [value] as unknown as ReturnType<PawworkLayoutProjectsInput["globalSync"]["child"]>
      },
      data: { project: opts.dataProjects ?? [] } as unknown as PawworkLayoutProjectsInput["globalSync"]["data"],
      project: {
        icon: () => undefined,
        meta: () => undefined,
        loadSessions: () => Promise.resolve(),
      } as unknown as PawworkLayoutProjectsInput["globalSync"]["project"],
      ready: opts.ready ?? true,
    },
    server: {
      projects: {
        list: () => opts.serverProjects ?? [],
        close: () => undefined,
        open: () => undefined,
        expand: () => undefined,
      } as unknown as PawworkLayoutProjectsInput["server"]["projects"],
    },
  }
  return { input }
}

describe("createPawworkLayoutProjects rootFor", () => {
  test("returns the input directory when there are no sandbox roots", () => {
    createRoot((dispose) => {
      const { input } = setup()
      const { rootFor } = createPawworkLayoutProjects(input)
      expect(rootFor("/some/path")).toBe("/some/path")
      dispose()
    })
  })

  test("walks the sandbox chain to the root project", () => {
    createRoot((dispose) => {
      const { input } = setup({
        dataProjects: [{ worktree: "/root", sandboxes: ["/sb"] }],
      })
      const { rootFor } = createPawworkLayoutProjects(input)
      expect(rootFor("/sb")).toBe("/root")
      expect(rootFor("/root")).toBe("/root")
      expect(rootFor("/unknown")).toBe("/unknown")
      dispose()
    })
  })

  test("falls back to the input directory on a sandbox cycle", () => {
    createRoot((dispose) => {
      const { input } = setup({
        dataProjects: [
          { worktree: "/a", sandboxes: ["/b"] },
          { worktree: "/b", sandboxes: ["/a"] },
        ],
      })
      const { rootFor } = createPawworkLayoutProjects(input)
      expect(rootFor("/a")).toBe("/a")
      dispose()
    })
  })
})

describe("createPawworkLayoutProjects list memo", () => {
  test("returns server projects enriched with metadata", () => {
    createRoot((dispose) => {
      const { input } = setup({
        serverProjects: [{ worktree: "/w", expanded: true }],
        dataProjects: [{ id: "p1", worktree: "/w", name: "Demo", icon: { color: "pink" } }],
        childStores: { "/w": { project: "p1" } },
      })
      const { list } = createPawworkLayoutProjects(input)
      const items = list()
      expect(items).toHaveLength(1)
      expect(items[0].id).toBe("p1")
      expect(items[0].name).toBe("Demo")
      expect(items[0].icon?.color).toBe("pink")
      dispose()
    })
  })

  test("prefers child icon when metadata has no override", () => {
    createRoot((dispose) => {
      const { input } = setup({
        serverProjects: [{ worktree: "/w", expanded: false }],
        dataProjects: [{ id: "p1", worktree: "/w" }],
        childStores: { "/w": { project: "p1", icon: "X" } },
      })
      const { list } = createPawworkLayoutProjects(input)
      expect(list()[0].icon?.override).toBe("X")
      dispose()
    })
  })

  test("treats projectID === 'global' as a global project", () => {
    createRoot((dispose) => {
      const { input } = setup({
        serverProjects: [{ worktree: "/w", expanded: false }],
        dataProjects: [{ id: "global", worktree: "/w" }],
        childStores: { "/w": { project: "global", projectMeta: { name: "Local" } } },
      })
      const { list } = createPawworkLayoutProjects(input)
      const item = list()[0]
      expect(item.id).toBe("global")
      expect(item.name).toBe("Local")
      dispose()
    })
  })

  test("treats unknown id + local overrides as global", () => {
    createRoot((dispose) => {
      const { input } = setup({
        serverProjects: [{ worktree: "/w", expanded: false }],
        childStores: { "/w": { projectMeta: { name: "From local" } } },
      })
      const { list } = createPawworkLayoutProjects(input)
      const item = list()[0]
      expect(item.id).toBe("global")
      expect(item.name).toBe("From local")
      dispose()
    })
  })

  test("does not assign a global id when metadata is plain", () => {
    createRoot((dispose) => {
      const { input } = setup({
        serverProjects: [{ worktree: "/w", expanded: false }],
        dataProjects: [{ id: "p1", worktree: "/w" }],
        childStores: { "/w": { project: "p1" } },
      })
      const { list } = createPawworkLayoutProjects(input)
      expect(list()[0].id).toBe("p1")
      dispose()
    })
  })
})
