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
            { name: "README.md", path: file, type: "file", size: 1, mtimeMs: 1 },
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
})
