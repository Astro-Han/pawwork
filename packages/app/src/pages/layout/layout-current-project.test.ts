import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createCurrentProjectMemo } from "./layout-current-project"

type Project = { id?: string; worktree: string; expanded?: boolean; sandboxes?: string[] }

function setup(opts: {
  currentDir?: string
  projects?: Project[]
  child?: { project?: string }
  dataProjects?: { id?: string; worktree?: string }[]
}) {
  type Input = Parameters<typeof createCurrentProjectMemo>[0]
  return {
    currentDir: () => opts.currentDir ?? "",
    layout: {
      projects: { list: () => opts.projects ?? [] },
    } as unknown as Input["layout"],
    globalSync: {
      child: () => [opts.child ?? {}] as const,
      data: { project: opts.dataProjects ?? [] },
    } as unknown as Input["globalSync"],
  }
}

describe("createCurrentProjectMemo", () => {
  test("returns undefined when there is no current directory", () => {
    createRoot((dispose) => {
      const memo = createCurrentProjectMemo(setup({ currentDir: "" }))
      expect(memo()).toBeUndefined()
      dispose()
    })
  })

  test("matches a project by direct worktree", () => {
    createRoot((dispose) => {
      const memo = createCurrentProjectMemo(setup({ currentDir: "/foo", projects: [{ worktree: "/foo" }] }))
      expect(memo()?.worktree).toBe("/foo")
      dispose()
    })
  })

  test("matches a project by sandbox membership", () => {
    createRoot((dispose) => {
      const memo = createCurrentProjectMemo(
        setup({ currentDir: "/sb", projects: [{ worktree: "/root", sandboxes: ["/sb"] }] }),
      )
      expect(memo()?.worktree).toBe("/root")
      dispose()
    })
  })

  test("prefers the sandbox owner when both sandbox and direct could match", () => {
    createRoot((dispose) => {
      const memo = createCurrentProjectMemo(
        setup({
          currentDir: "/x",
          projects: [{ worktree: "/owner", sandboxes: ["/x"] }, { worktree: "/x" }],
        }),
      )
      expect(memo()?.worktree).toBe("/owner")
      dispose()
    })
  })

  test("resolves through the globalSync child project id to the root project", () => {
    createRoot((dispose) => {
      const memo = createCurrentProjectMemo(
        setup({
          currentDir: "/somewhere",
          projects: [{ worktree: "/root" }],
          child: { project: "p1" },
          dataProjects: [{ id: "p1", worktree: "/root" }],
        }),
      )
      expect(memo()?.worktree).toBe("/root")
      dispose()
    })
  })

  test("returns undefined when child has no project id and nothing matches directly", () => {
    createRoot((dispose) => {
      const memo = createCurrentProjectMemo(
        setup({ currentDir: "/unknown", projects: [{ worktree: "/root" }], child: {} }),
      )
      expect(memo()).toBeUndefined()
      dispose()
    })
  })
})
