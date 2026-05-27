import { $ } from "bun"
import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { ConfigProvider, Deferred, Effect, Layer, ManagedRuntime, Option } from "effect"
import { tmpdir } from "../fixture/fixture"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { FileWatcher } from "../../src/file/watcher"
import { Git } from "../../src/git"
import { Instance } from "../../src/project/instance"

// Native @parcel/watcher bindings aren't reliably available in CI (missing on Linux, flaky on Windows)
const describeWatcher = FileWatcher.hasNativeBinding() && !process.env.CI ? describe : describe.skip

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const watcherConfigLayer = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    OPENCODE_EXPERIMENTAL_FILEWATCHER: "true",
    OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "false",
  }),
)

type WatcherEvent = { file: string; event: "add" | "change" | "unlink" }
type RescanEvent = { directory: string }

/** Run `body` with a live FileWatcher service. */
function withWatcher<E>(directory: string, body: Effect.Effect<void, E>) {
  return Instance.provide({
    directory,
    fn: async () => {
      const layer: Layer.Layer<FileWatcher.Service, never, never> = FileWatcher.layer.pipe(
        Layer.provide(Config.defaultLayer),
        Layer.provide(Git.defaultLayer),
        Layer.provide(watcherConfigLayer),
      )
      const rt = ManagedRuntime.make(layer)
      try {
        await rt.runPromise(FileWatcher.Service.use((s) => s.init()))
        await Effect.runPromise(ready(directory))
        await Effect.runPromise(body)
      } finally {
        await rt.dispose()
      }
    },
  })
}

function listen(directory: string, check: (evt: WatcherEvent) => boolean, hit: (evt: WatcherEvent) => void) {
  let done = false

  const unsub = Bus.subscribe(FileWatcher.Event.Updated, (evt) => {
    if (done) return
    if (!check(evt.properties)) return
    hit(evt.properties)
  })

  return () => {
    if (done) return
    done = true
    unsub()
  }
}

function wait(directory: string, check: (evt: WatcherEvent) => boolean) {
  return Effect.gen(function* () {
    const deferred = yield* Deferred.make<WatcherEvent>()
    const cleanup = yield* Effect.sync(() => {
      let off = () => {}
      off = listen(directory, check, (evt) => {
        off()
        Deferred.doneUnsafe(deferred, Effect.succeed(evt))
      })
      return off
    })
    return { cleanup, deferred }
  })
}

function waitRescan(check: (evt: RescanEvent) => boolean) {
  return Effect.gen(function* () {
    const deferred = yield* Deferred.make<RescanEvent>()
    const cleanup = yield* Effect.sync(() => {
      let done = false
      const unsub = Bus.subscribe(FileWatcher.Event.Rescan, (evt) => {
        if (done) return
        if (!check(evt.properties)) return
        done = true
        unsub()
        Deferred.doneUnsafe(deferred, Effect.succeed(evt.properties))
      })
      return () => {
        if (done) return
        done = true
        unsub()
      }
    })
    return { cleanup, deferred }
  })
}

function nextUpdate<E>(directory: string, check: (evt: WatcherEvent) => boolean, trigger: Effect.Effect<void, E>) {
  return Effect.acquireUseRelease(
    wait(directory, check),
    ({ deferred }) =>
      Effect.gen(function* () {
        yield* trigger
        return yield* Deferred.await(deferred).pipe(Effect.timeout("5 seconds"))
      }),
    ({ cleanup }) => Effect.sync(cleanup),
  )
}

function nextRescan<E>(check: (evt: RescanEvent) => boolean, trigger: Effect.Effect<void, E>) {
  return Effect.acquireUseRelease(
    waitRescan(check),
    ({ deferred }) =>
      Effect.gen(function* () {
        yield* trigger
        return yield* Deferred.await(deferred).pipe(Effect.timeout("5 seconds"))
      }),
    ({ cleanup }) => Effect.sync(cleanup),
  )
}

function noRescan<E>(check: (evt: RescanEvent) => boolean, trigger: Effect.Effect<void, E>, ms = 500) {
  return Effect.acquireUseRelease(
    waitRescan(check),
    ({ deferred }) =>
      Effect.gen(function* () {
        yield* trigger
        expect(yield* Deferred.await(deferred).pipe(Effect.timeoutOption(`${ms} millis`))).toEqual(Option.none())
      }),
    ({ cleanup }) => Effect.sync(cleanup),
  )
}

/** Effect that asserts no matching event arrives within `ms`. */
function noUpdate<E>(
  directory: string,
  check: (evt: WatcherEvent) => boolean,
  trigger: Effect.Effect<void, E>,
  ms = 500,
) {
  return Effect.acquireUseRelease(
    wait(directory, check),
    ({ deferred }) =>
      Effect.gen(function* () {
        yield* trigger
        expect(yield* Deferred.await(deferred).pipe(Effect.timeoutOption(`${ms} millis`))).toEqual(Option.none())
      }),
    ({ cleanup }) => Effect.sync(cleanup),
  )
}

function ready(directory: string) {
  const file = path.join(directory, `.watcher-${Math.random().toString(36).slice(2)}`)
  const head = path.join(directory, ".git", "HEAD")

  return Effect.gen(function* () {
    yield* nextUpdate(
      directory,
      (evt) => evt.file === file && evt.event === "add",
      Effect.promise(() => fs.writeFile(file, "ready")),
    ).pipe(Effect.ensuring(Effect.promise(() => fs.rm(file, { force: true }).catch(() => undefined))), Effect.asVoid)

    const git = yield* Effect.promise(() =>
      fs
        .stat(head)
        .then(() => true)
        .catch(() => false),
    )
    if (!git) return

    const branch = `watch-${Math.random().toString(36).slice(2)}`
    const hash = yield* Effect.promise(() => $`git rev-parse HEAD`.cwd(directory).quiet().text())
    yield* nextUpdate(
      directory,
      (evt) => evt.file === head && evt.event !== "unlink",
      Effect.promise(async () => {
        await fs.writeFile(path.join(directory, ".git", "refs", "heads", branch), hash.trim() + "\n")
        await fs.writeFile(head, `ref: refs/heads/${branch}\n`)
      }),
    ).pipe(Effect.asVoid)
  })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FileWatcher git metadata filtering", () => {
  test("builds an explainable macOS workspace watch plan", () => {
    const repo = path.join("/tmp", "repo")
    const plan = FileWatcher.workspaceWatchPlan({
      directory: repo,
      backend: "fs-events",
      entries: [
        { name: ".claude", type: "directory" },
        { name: ".claire", type: "directory" },
        { name: ".superpowers", type: "directory" },
        { name: ".turbo", type: "directory" },
        { name: ".worktrees", type: "directory" },
        { name: "logs", type: "directory" },
        { name: "local-cache", type: "directory" },
        { name: "node_modules", type: "directory" },
        { name: "packages", type: "directory" },
        { name: "src", type: "directory" },
        { name: "README.md", type: "file" },
      ],
      ignore: FileWatcher.workspaceWatcherIgnoreEntries({ config: ["local-cache/**"], protected: [] }),
      userConfig: ["local-cache/**"],
    })

    expect(plan.rootFilesStrategy).toBe("poll-root-entries")
    expect(plan.refreshStrategy).toBe("refresh-plan-on-top-level-entry-change")
    expect(plan.roots.map((root) => path.basename(root.directory)).sort()).toEqual(["packages", "src"])
    expect(plan.excluded.map((item) => [path.basename(item.path), item.reason]).sort()).toEqual([
      [".claire", "local-artifact"],
      [".claude", "local-artifact"],
      [".superpowers", "local-artifact"],
      [".turbo", "default-ignore"],
      [".worktrees", "local-artifact"],
      ["local-cache", "user-config"],
      ["logs", "default-ignore"],
      ["node_modules", "default-ignore"],
    ])
    expect(plan.rootFiles).toEqual([path.join(repo, "README.md")])
  })

  test("keeps workspace ignore semantics for child subscriptions", () => {
    const repo = path.join("/tmp", "repo")
    const child = path.join(repo, "packages")
    const ignore = FileWatcher.subscriptionIgnoreEntries({
      workspace: repo,
      subscription: child,
      ignore: ["custom-cache", "packages/generated", "**/*.log", path.join(repo, "secret")],
    })

    expect(ignore).toContain(path.join(repo, "custom-cache"))
    expect(ignore).toContain(path.join(repo, "packages", "generated"))
    expect(ignore).toContain("**/*.log")
    expect(ignore).toContain(path.join(repo, "secret"))
  })

  test("ignores nested PawWork worktree roots from the workspace watcher", () => {
    const entries = FileWatcher.workspaceWatcherIgnoreEntries({
      config: ["custom-cache"],
      protected: ["/secret"],
    })

    expect(entries).toContain("node_modules")
    expect(entries).toContain(".worktrees")
    expect(entries).toContain("custom-cache")
    expect(entries).toContain("/secret")
  })

  test("summarizes workspace watcher subscription diagnostics", () => {
    const subscription = FileWatcher.workspaceWatcherSubscription({
      directory: "/repo",
      backend: "fs-events",
      configIgnores: ["custom-cache"],
      protectedPaths: ["/secret"],
    })

    expect(subscription.ignore).toContain("node_modules")
    expect(subscription.ignore).toContain(".worktrees")
    expect(subscription.ignore).toContain("custom-cache")
    expect(subscription.ignore).toContain("/secret")
    expect(subscription.diagnostics).toEqual({
      dir: "/repo",
      backend: "fs-events",
      watch_scope: "workspace",
      ignore_count: subscription.ignore.length,
      ignores_worktrees: true,
    })
  })

  test("keeps review-diff git metadata subscribed", () => {
    expect(
      FileWatcher.vcsWatcherIgnoreEntries(["HEAD", "index", "packed-refs", "refs", "objects", "logs", "hooks"]),
    ).toEqual(["objects", "logs", "hooks"])
  })

  test("publishes only review-diff git metadata from the vcs directory", () => {
    const gitDir = path.join("/tmp", "repo", ".git")

    expect(FileWatcher.shouldPublishVcsWatcherPath(path.join(gitDir, "HEAD"), gitDir)).toBe(true)
    expect(FileWatcher.shouldPublishVcsWatcherPath(path.join(gitDir, "index"), gitDir)).toBe(true)
    expect(FileWatcher.shouldPublishVcsWatcherPath(path.join(gitDir, "packed-refs"), gitDir)).toBe(true)
    expect(FileWatcher.shouldPublishVcsWatcherPath(path.join(gitDir, "refs", "heads", "feature"), gitDir)).toBe(true)
    expect(FileWatcher.shouldPublishVcsWatcherPath(path.join(gitDir, "refs", "remotes", "origin", "dev"), gitDir)).toBe(
      true,
    )

    expect(FileWatcher.shouldPublishVcsWatcherPath(path.join(gitDir, "objects", "ab", "hash"), gitDir)).toBe(false)
    expect(FileWatcher.shouldPublishVcsWatcherPath(path.join(gitDir, "refs", "tags", "v1"), gitDir)).toBe(false)
    expect(FileWatcher.shouldPublishVcsWatcherPath(path.join(gitDir, "refs", "stash"), gitDir)).toBe(false)
    expect(FileWatcher.shouldPublishVcsWatcherPath(path.join(gitDir, "MERGE_HEAD"), gitDir)).toBe(false)
  })
})

describeWatcher("FileWatcher", () => {
  afterEach(async () => {
    await Instance.disposeAll()
  })

  test("publishes root create, update, and delete events", async () => {
    await using tmp = await tmpdir({ git: true })
    const file = path.join(tmp.path, "watch.txt")
    const dir = tmp.path
    const cases = [
      { event: "add" as const, trigger: Effect.promise(() => fs.writeFile(file, "a")) },
      { event: "change" as const, trigger: Effect.promise(() => fs.writeFile(file, "b")) },
      { event: "unlink" as const, trigger: Effect.promise(() => fs.unlink(file)) },
    ]

    await withWatcher(
      dir,
      Effect.forEach(cases, ({ event, trigger }) =>
        nextUpdate(dir, (evt) => evt.file === file && evt.event === event, trigger).pipe(
          Effect.tap((evt) => Effect.sync(() => expect(evt).toEqual({ file, event }))),
        ),
      ),
    )
  })

  test("watches non-git roots", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "plain.txt")
    const dir = tmp.path

    await withWatcher(
      dir,
      nextUpdate(
        dir,
        (e) => e.file === file && e.event === "add",
        Effect.promise(() => fs.writeFile(file, "plain")),
      ).pipe(Effect.tap((evt) => Effect.sync(() => expect(evt).toEqual({ file, event: "add" })))),
    )
  })

  test("cleanup stops publishing events", async () => {
    await using tmp = await tmpdir({ git: true })
    const file = path.join(tmp.path, "after-dispose.txt")

    // Start and immediately stop the watcher (withWatcher disposes on exit)
    await withWatcher(tmp.path, Effect.void)

    // Now write a file — no watcher should be listening
    await Instance.provide({
      directory: tmp.path,
      fn: () =>
        Effect.runPromise(
          noUpdate(
            tmp.path,
            (e) => e.file === file,
            Effect.promise(() => fs.writeFile(file, "gone")),
          ),
        ),
    })
  })

  test("ignores local artifact roots from workspace updates", async () => {
    await using tmp = await tmpdir({ git: true })
    const artifact = path.join(tmp.path, ".claude")
    const file = path.join(artifact, "settings.local.json")

    await withWatcher(
      tmp.path,
      noUpdate(
        tmp.path,
        (evt) => evt.file === file,
        noRescan(
          (evt) => evt.directory === tmp.path,
          Effect.promise(async () => {
            await fs.mkdir(artifact)
            await fs.writeFile(file, "{}")
          }),
          1_000,
        ),
        1_000,
      ),
    )
  })

  test("refreshes the watch plan for new top-level directories", async () => {
    await using tmp = await tmpdir({ git: true })
    const dir = path.join(tmp.path, "generated")
    const first = path.join(dir, "first.txt")
    const second = path.join(dir, "second.txt")

    await withWatcher(
      tmp.path,
      Effect.gen(function* () {
        yield* nextRescan(
          (evt) => evt.directory === tmp.path,
          Effect.promise(async () => {
            await fs.mkdir(dir)
            await fs.writeFile(first, "first")
          }),
        )
        yield* nextUpdate(
          tmp.path,
          (evt) => evt.file === second && evt.event === "add",
          Effect.promise(() => fs.writeFile(second, "second")),
        )
      }),
    )
  })

  test("publishes .git/index changes", async () => {
    await using tmp = await tmpdir({ git: true })
    const gitIndex = path.join(tmp.path, ".git", "index")
    const edit = path.join(tmp.path, "tracked.txt")

    await withWatcher(
      tmp.path,
      nextUpdate(
        tmp.path,
        (e) => e.file === gitIndex,
        Effect.promise(async () => {
          await fs.writeFile(edit, "a")
          await $`git add .`.cwd(tmp.path).quiet().nothrow()
        }),
      ).pipe(Effect.tap((evt) => Effect.sync(() => expect(evt.event).not.toBe("unlink")))),
    )
  })

  test("publishes .git refs/heads changes", async () => {
    await using tmp = await tmpdir({ git: true })
    const branchRef = path.join(tmp.path, ".git", "refs", "heads", "watch-ref")
    const hash = await $`git rev-parse HEAD`.cwd(tmp.path).quiet().text()

    await withWatcher(
      tmp.path,
      nextUpdate(
        tmp.path,
        (evt) => evt.file === branchRef && evt.event !== "unlink",
        Effect.promise(() => fs.writeFile(branchRef, hash.trim() + "\n")),
      ).pipe(Effect.tap((evt) => Effect.sync(() => expect(["add", "change"]).toContain(evt.event)))),
    )
  })

  test("publishes .git/packed-refs changes", async () => {
    await using tmp = await tmpdir({ git: true })
    const packedRefs = path.join(tmp.path, ".git", "packed-refs")

    await withWatcher(
      tmp.path,
      nextUpdate(
        tmp.path,
        (evt) => evt.file === packedRefs && evt.event !== "unlink",
        Effect.promise(() => fs.writeFile(packedRefs, "# pack-refs with: peeled fully-peeled sorted\n")),
      ).pipe(Effect.tap((evt) => Effect.sync(() => expect(["add", "change"]).toContain(evt.event)))),
    )
  })

  test("publishes .git/HEAD events", async () => {
    await using tmp = await tmpdir({ git: true })
    const head = path.join(tmp.path, ".git", "HEAD")
    const branch = `watch-${Math.random().toString(36).slice(2)}`
    await $`git branch ${branch}`.cwd(tmp.path).quiet()

    await withWatcher(
      tmp.path,
      nextUpdate(
        tmp.path,
        (evt) => evt.file === head && evt.event !== "unlink",
        Effect.promise(() => fs.writeFile(head, `ref: refs/heads/${branch}\n`)),
      ).pipe(
        Effect.tap((evt) =>
          Effect.sync(() => {
            expect(evt.file).toBe(head)
            expect(["add", "change"]).toContain(evt.event)
          }),
        ),
      ),
    )
  })
})
