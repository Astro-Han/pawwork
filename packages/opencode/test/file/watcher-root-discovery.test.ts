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
})
