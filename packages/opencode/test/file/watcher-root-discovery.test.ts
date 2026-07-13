import { describe, expect, test } from "bun:test"
import { FileWatcher } from "../../src/file/watcher"

describe("workspace root discovery", () => {
  test("healthy idle creates no fallback timer or root snapshot work", async () => {
    let snapshots = 0
    let timers = 0
    const discovery = FileWatcher.createWorkspaceRootDiscovery({
      initialSnapshot: new Map(),
      workspace: "/repo",
      ignore: [],
      subscribeSentinel: async () => ({ unsubscribe: async () => {} }),
      snapshotRoot: async () => {
        snapshots++
        return new Map()
      },
      applyPlan: async () => {},
      publishUpdate: () => {},
      publishRescan: async () => {},
      scheduleFallback: () => {
        timers++
        return () => {}
      },
    })

    await discovery.start()

    expect(snapshots).toBe(0)
    expect(timers).toBe(0)
    await discovery.dispose()
  })

  test("coalesces a burst of sentinel hints into one snapshot reconcile", async () => {
    const workspace = "/repo"
    const file = `${workspace}/README.md`
    let signal!: (signal: FileWatcher.WorkspaceRootSentinelSignal) => void
    let snapshots = 0
    let published!: () => void
    const update = new Promise<void>((resolve) => {
      published = resolve
    })
    const discovery = FileWatcher.createWorkspaceRootDiscovery({
      initialSnapshot: new Map(),
      workspace,
      ignore: [],
      subscribeSentinel: async (_snapshot, callback) => {
        signal = callback
        return { unsubscribe: async () => {} }
      },
      snapshotRoot: async () => {
        snapshots++
        return new Map([
          [
            "README.md",
            { name: "README.md", path: file, type: "file", size: 1, mtimeMs: 1, ino: 1, ctimeMs: 1 },
          ],
        ])
      },
      applyPlan: async () => {},
      publishUpdate: () => published(),
      publishRescan: async () => {},
      scheduleFallback: () => () => {},
    })

    await discovery.start()
    signal({})
    signal({})
    signal({})
    await update

    expect(snapshots).toBe(1)
    await discovery.dispose()
  })

  test("detects a same-size atomic root-file replacement", async () => {
    const workspace = "/repo"
    const file = `${workspace}/package.json`
    const state = (ino: number, ctimeMs: number) => ({
      name: "package.json",
      path: file,
      type: "file" as const,
      size: 20,
      mtimeMs: 100,
      ino,
      ctimeMs,
    })
    const updates: Array<{ file: string; event: "add" | "change" | "unlink" }> = []

    await FileWatcher.runWorkspaceRootPoll({
      previous: new Map([["package.json", state(1, 100)]]),
      next: new Map([["package.json", state(2, 101)]]),
      workspace,
      ignore: [],
      isDisposed: () => false,
      applyPlan: async () => {},
      publishUpdate: (event) => updates.push(event),
      publishRescan: async () => {},
    })

    expect(updates).toEqual([{ file, event: "change" }])
  })

  test("updates the child plan before safely rebuilding the sentinel and rescanning", async () => {
    const workspace = "/repo"
    const directory = `${workspace}/generated`
    const next = new Map([
      [
        "generated",
        {
          name: "generated",
          path: directory,
          type: "directory" as const,
          size: 0,
          mtimeMs: 0,
          ino: 0,
          ctimeMs: 0,
        },
      ],
    ])
    const order: string[] = []
    let signal!: (signal: FileWatcher.WorkspaceRootSentinelSignal) => void
    let subscriptions = 0
    let rescanned!: () => void
    const rescan = new Promise<void>((resolve) => {
      rescanned = resolve
    })
    const discovery = FileWatcher.createWorkspaceRootDiscovery({
      initialSnapshot: new Map(),
      workspace,
      ignore: [],
      subscribeSentinel: async (snapshot, callback) => {
        subscriptions++
        signal = callback
        order.push(`subscribe:${[...snapshot.keys()].join(",")}`)
        const id = subscriptions
        return { unsubscribe: async () => void order.push(`unsubscribe:${id}`) }
      },
      snapshotRoot: async () => next,
      applyPlan: async () => void order.push("apply-plan"),
      publishUpdate: () => {},
      publishRescan: async () => {
        order.push("rescan")
        rescanned()
      },
      scheduleFallback: () => () => {},
    })

    await discovery.start()
    signal({})
    await rescan

    expect(order).toEqual([
      "subscribe:",
      "apply-plan",
      "subscribe:generated",
      "unsubscribe:1",
      "rescan",
    ])
    await discovery.dispose()
  })
})
