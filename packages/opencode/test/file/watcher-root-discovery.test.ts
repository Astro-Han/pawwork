import { describe, expect, test } from "bun:test"
import path from "path"
import { FileWatcher } from "../../src/file/watcher"
import { tmpdir } from "../fixture/fixture"

describe("workspace root discovery", () => {
  const darwinLiveTest = process.platform === "darwin" ? test : test.skip

  darwinLiveTest(
    "uses native kqueue and isolates ignored subtree churn",
    async () => {
      await using tmp = await tmpdir()
      const probe = Bun.spawnSync([process.execPath, path.join(import.meta.dir, "watcher-kqueue-live.ts"), tmp.path], {
        cwd: path.join(import.meta.dir, "../.."),
        env: process.env,
      })

      expect(probe.exitCode).toBe(0)
      const result = JSON.parse(probe.stdout.toString()) as {
        kqueueDescriptorDelta: number
        ignoredCallbacks: number
        idleSnapshots: number
        rootCallbacks: number
        rootUpdates: number
        fallbackTimers: number
        callbackError?: string
        discoveryErrors: string[]
      }
      expect(result).toEqual({
        kqueueDescriptorDelta: 1,
        ignoredCallbacks: 0,
        idleSnapshots: 0,
        rootCallbacks: 4,
        rootUpdates: 4,
        fallbackTimers: 0,
        discoveryErrors: [],
      })
    },
    15_000,
  )

  test("subscribes a root-only kqueue sentinel that ignores every current top-level directory", async () => {
    const workspace = "/repo"
    const ignored = [`${workspace}/packages`, `${workspace}/src`]
    let options: { backend?: string; ignore?: string[] } | undefined
    let callback!: (error: Error | null, events: Array<{ path: string; type: "create" }>) => void
    let signals = 0
    const subscription = await FileWatcher.subscribeWorkspaceRootSentinel({
      workspace,
      snapshot: new Map([
        [
          "packages",
          {
            name: "packages",
            path: ignored[0]!,
            type: "directory",
            size: 0,
            mtimeMs: 0,
            ino: 0,
            ctimeMs: 0,
          },
        ],
        [
          "README.md",
          {
            name: "README.md",
            path: `${workspace}/README.md`,
            type: "file",
            size: 1,
            mtimeMs: 1,
            ino: 1,
            ctimeMs: 1,
          },
        ],
        [
          "src",
          {
            name: "src",
            path: ignored[1]!,
            type: "directory",
            size: 0,
            mtimeMs: 0,
            ino: 0,
            ctimeMs: 0,
          },
        ],
      ]),
      signal: () => {
        signals++
      },
      binding: {
        subscribe: async (_directory, nextCallback, nextOptions) => {
          callback = nextCallback
          options = nextOptions
          return { unsubscribe: async () => {} }
        },
      },
    })

    expect(options?.backend).toBe("kqueue")
    expect(options?.ignore).toEqual(ignored)
    callback(null, [{ path: `${workspace}/README.md`, type: "create" }])
    expect(signals).toBe(1)
    await subscription.unsubscribe()
  })

  test("healthy idle creates no fallback timer or root snapshot work after bootstrap", async () => {
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
    const bootstrapSnapshots = snapshots
    await Bun.sleep(0)

    expect(bootstrapSnapshots).toBe(1)
    expect(snapshots).toBe(bootstrapSnapshots)
    expect(timers).toBe(0)
    await discovery.dispose()
  })

  test("catches up root changes that happen before the sentinel is active", async () => {
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
          ino: 1,
          ctimeMs: 1,
        },
      ],
    ])
    let root = new Map<string, FileWatcher.RootEntryState>()
    const plans: string[][] = []
    const discovery = FileWatcher.createWorkspaceRootDiscovery({
      initialSnapshot: root,
      workspace,
      ignore: [],
      subscribeSentinel: async () => {
        root = next
        return { unsubscribe: async () => {} }
      },
      snapshotRoot: async () => root,
      applyPlan: async (snapshot) => {
        plans.push([...snapshot.keys()])
      },
      publishUpdate: () => {},
      publishRescan: async () => {},
      scheduleFallback: () => () => {},
    })

    await discovery.start()

    expect(plans).toEqual([["generated"]])
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
        if (snapshots === 1) return new Map()
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
    const bootstrapSnapshots = snapshots
    signal({})
    signal({})
    signal({})
    await update

    expect(snapshots - bootstrapSnapshots).toBe(1)
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
      "unsubscribe:1",
      "subscribe:generated",
      "rescan",
    ])
    await discovery.dispose()
  })

  test("polls with backoff only after sentinel failure and cancels fallback on recovery", async () => {
    let attempts = 0
    let snapshots = 0
    let fallback!: () => void
    let cancelled = 0
    let recovered!: () => void
    const recovery = new Promise<void>((resolve) => {
      recovered = resolve
    })
    const discovery = FileWatcher.createWorkspaceRootDiscovery({
      initialSnapshot: new Map(),
      workspace: "/repo",
      ignore: [],
      subscribeSentinel: async () => {
        attempts++
        if (attempts === 1) throw new Error("kqueue unavailable")
        recovered()
        return { unsubscribe: async () => {} }
      },
      snapshotRoot: async () => {
        snapshots++
        return new Map()
      },
      applyPlan: async () => {},
      publishUpdate: () => {},
      publishRescan: async () => {},
      scheduleFallback: (callback, delayMs) => {
        expect(delayMs).toBe(500)
        fallback = callback
        return () => {
          cancelled++
        }
      },
    })

    await discovery.start()
    expect(snapshots).toBe(0)

    fallback()
    await recovery

    expect(attempts).toBe(2)
    expect(snapshots).toBe(1)
    expect(cancelled).toBe(1)
    await discovery.dispose()
  })

  test("serializes fallback recovery behind an in-flight sentinel reconcile", async () => {
    let signal!: (signal: FileWatcher.WorkspaceRootSentinelSignal) => void
    let fallback!: () => void
    let snapshots = 0
    let activeSnapshots = 0
    let maxActiveSnapshots = 0
    let firstStarted!: () => void
    let releaseFirst!: () => void
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve
    })
    const blocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const discovery = FileWatcher.createWorkspaceRootDiscovery({
      initialSnapshot: new Map(),
      workspace: "/repo",
      ignore: [],
      subscribeSentinel: async (_snapshot, callback) => {
        signal = callback
        return { unsubscribe: async () => {} }
      },
      snapshotRoot: async () => {
        snapshots++
        if (snapshots === 1) return new Map()
        activeSnapshots++
        maxActiveSnapshots = Math.max(maxActiveSnapshots, activeSnapshots)
        if (snapshots === 2) {
          firstStarted()
          await blocked
        }
        activeSnapshots--
        return new Map()
      },
      applyPlan: async () => {},
      publishUpdate: () => {},
      publishRescan: async () => {},
      scheduleFallback: (callback) => {
        fallback = callback
        return () => {}
      },
    })

    await discovery.start()
    signal({})
    await started
    signal({ error: new Error("sentinel failed") })
    fallback()
    await Bun.sleep(0)
    releaseFirst()
    await Bun.sleep(0)

    expect(maxActiveSnapshots).toBe(1)
    await discovery.dispose()
  })

  test("bounds repeated sentinel recovery backoff", async () => {
    const scheduled: Array<{ callback: () => void; delayMs: number }> = []
    const discovery = FileWatcher.createWorkspaceRootDiscovery({
      initialSnapshot: new Map(),
      workspace: "/repo",
      ignore: [],
      subscribeSentinel: async () => {
        throw new Error("still unavailable")
      },
      snapshotRoot: async () => new Map(),
      applyPlan: async () => {},
      publishUpdate: () => {},
      publishRescan: async () => {},
      scheduleFallback: (callback, delayMs) => {
        scheduled.push({ callback, delayMs })
        return () => {}
      },
    })

    await discovery.start()
    for (let index = 0; index < 5; index++) {
      scheduled[index]!.callback()
      while (scheduled.length === index + 1) await Bun.sleep(0)
    }

    expect(scheduled.map((item) => item.delayMs)).toEqual([500, 1_000, 2_000, 4_000, 5_000, 5_000])
    await discovery.dispose()
  })

  test("retries failed sentinel cleanup before opening a replacement", async () => {
    const workspace = "/repo"
    const directory = `${workspace}/generated`
    const empty = new Map<string, FileWatcher.RootEntryState>()
    const changed = new Map([
      [
        "generated",
        {
          name: "generated",
          path: directory,
          type: "directory" as const,
          size: 0,
          mtimeMs: 0,
          ino: 1,
          ctimeMs: 1,
        },
      ],
    ])
    let root = empty
    let signal!: (signal: FileWatcher.WorkspaceRootSentinelSignal) => void
    let fallback!: () => void
    let scheduled!: () => void
    const fallbackScheduled = new Promise<void>((resolve) => {
      scheduled = resolve
    })
    let recovered!: () => void
    const recovery = new Promise<void>((resolve) => {
      recovered = resolve
    })
    const order: string[] = []
    let subscriptions = 0
    let firstUnsubscribeAttempts = 0
    const discovery = FileWatcher.createWorkspaceRootDiscovery({
      initialSnapshot: empty,
      workspace,
      ignore: [],
      subscribeSentinel: async (_snapshot, callback) => {
        subscriptions++
        const id = subscriptions
        signal = callback
        order.push(`subscribe:${id}`)
        if (id === 2) recovered()
        return {
          unsubscribe: async () => {
            order.push(`unsubscribe:${id}`)
            if (id !== 1) return
            firstUnsubscribeAttempts++
            if (firstUnsubscribeAttempts === 1) throw new Error("cleanup failed")
          },
        }
      },
      snapshotRoot: async () => root,
      applyPlan: async () => {},
      publishUpdate: () => {},
      publishRescan: async () => {},
      scheduleFallback: (callback) => {
        fallback = callback
        scheduled()
        return () => {}
      },
      onError: () => {},
    })

    await discovery.start()
    root = changed
    signal({})
    await fallbackScheduled
    fallback()
    await recovery

    expect(order).toEqual(["subscribe:1", "unsubscribe:1", "unsubscribe:1", "subscribe:2"])
    await discovery.dispose()
  })

  test("dispose cancels sentinel, fallback, and in-flight publication", async () => {
    const workspace = "/repo"
    const file = `${workspace}/late.txt`
    let signal!: (signal: FileWatcher.WorkspaceRootSentinelSignal) => void
    let releaseSnapshot!: (snapshot: Map<string, FileWatcher.RootEntryState>) => void
    let snapshotStarted!: () => void
    const started = new Promise<void>((resolve) => {
      snapshotStarted = resolve
    })
    const snapshot = new Promise<Map<string, FileWatcher.RootEntryState>>((resolve) => {
      releaseSnapshot = resolve
    })
    let unsubscribed = 0
    let published = 0
    let fallbackCancelled = 0
    let snapshots = 0
    const discovery = FileWatcher.createWorkspaceRootDiscovery({
      initialSnapshot: new Map(),
      workspace,
      ignore: [],
      subscribeSentinel: async (_snapshot, callback) => {
        signal = callback
        return {
          unsubscribe: async () => {
            unsubscribed++
          },
        }
      },
      snapshotRoot: async () => {
        snapshots++
        if (snapshots === 1) return new Map()
        snapshotStarted()
        return snapshot
      },
      applyPlan: async () => {},
      publishUpdate: () => {
        published++
      },
      publishRescan: async () => {
        published++
      },
      scheduleFallback: () => () => {
        fallbackCancelled++
      },
    })

    await discovery.start()
    signal({})
    await started
    signal({ error: new Error("sentinel failed") })
    await discovery.dispose()
    releaseSnapshot(
      new Map([
        [
          "late.txt",
          { name: "late.txt", path: file, type: "file", size: 1, mtimeMs: 1, ino: 1, ctimeMs: 1 },
        ],
      ]),
    )
    await Bun.sleep(0)

    expect(unsubscribed).toBe(1)
    expect(fallbackCancelled).toBe(1)
    expect(published).toBe(0)
  })
})
