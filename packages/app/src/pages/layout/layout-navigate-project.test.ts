import { describe, expect, test } from "bun:test"
import { createNavigateProjectByOffset } from "./layout-navigate-project"

function setup(opts: {
  projects?: { worktree: string }[]
  current?: string
  currentDir?: string
  projectRoot?: (dir: string) => string
}) {
  // `events` records the cross-call order so the child-before-openProject
  // warm-up invariant is actually provable (separate arrays cannot prove it).
  const calls = { child: [] as string[], openProject: [] as string[], events: [] as string[] }
  type Input = Parameters<typeof createNavigateProjectByOffset>[0]
  const navigate = createNavigateProjectByOffset({
    layout: { projects: { list: () => opts.projects ?? [] } } as unknown as Input["layout"],
    currentProject: (() =>
      opts.current ? { worktree: opts.current } : undefined) as unknown as Input["currentProject"],
    currentDir: () => opts.currentDir ?? "",
    projectRoot: opts.projectRoot ?? ((dir: string) => dir),
    globalSync: {
      child: (worktree: string) => {
        calls.child.push(worktree)
        calls.events.push(`child:${worktree}`)
        return [{}]
      },
    } as unknown as Input["globalSync"],
    openProject: ((worktree: string) => {
      calls.openProject.push(worktree)
      calls.events.push(`open:${worktree}`)
      return Promise.resolve()
    }) as unknown as Input["openProject"],
  })
  return { navigate, calls }
}

const THREE = [{ worktree: "/a" }, { worktree: "/b" }, { worktree: "/c" }]

describe("createNavigateProjectByOffset", () => {
  test("does nothing when there are no projects", () => {
    const { navigate, calls } = setup({ projects: [] })
    navigate(1)
    expect(calls.openProject).toEqual([])
  })

  test("moves to the next project, warming the child store before opening it", () => {
    const { navigate, calls } = setup({ projects: THREE, current: "/b" })
    navigate(1)
    // Single ordered log proves child-store warm-up precedes openProject.
    expect(calls.events).toEqual(["child:/c", "open:/c"])
  })

  test("moves to the previous project", () => {
    const { navigate, calls } = setup({ projects: THREE, current: "/b" })
    navigate(-1)
    expect(calls.openProject).toEqual(["/a"])
  })

  test("wraps from the last project forward to the first", () => {
    const { navigate, calls } = setup({ projects: THREE, current: "/c" })
    navigate(1)
    expect(calls.openProject).toEqual(["/a"])
  })

  test("wraps from the first project backward to the last", () => {
    const { navigate, calls } = setup({ projects: THREE, current: "/a" })
    navigate(-1)
    expect(calls.openProject).toEqual(["/c"])
  })

  test("falls back to the first project forward when nothing is active", () => {
    const { navigate, calls } = setup({ projects: THREE, currentDir: "" })
    navigate(1)
    expect(calls.openProject).toEqual(["/a"])
  })

  test("falls back to the last project backward when nothing is active", () => {
    const { navigate, calls } = setup({ projects: THREE, currentDir: "" })
    navigate(-1)
    expect(calls.openProject).toEqual(["/c"])
  })

  test("resolves the active project from currentDir via projectRoot when no currentProject", () => {
    const { navigate, calls } = setup({
      projects: THREE,
      currentDir: "/somewhere",
      projectRoot: () => "/b",
    })
    navigate(1)
    expect(calls.openProject).toEqual(["/c"])
  })
})
