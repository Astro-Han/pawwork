import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber, Layer, ManagedRuntime } from "effect"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"

import { InstanceRef } from "../../src/effect/instance-ref"
import { registerDisposer } from "../../src/effect/instance-registry"
import { InstanceBootstrap } from "../../src/project/bootstrap-service"
import { Instance } from "../../src/project/instance"
import { InstanceStore } from "../../src/project/instance-store"
import { Project } from "../../src/project/project"
import { ProjectTable } from "../../src/project/project.sql"
import { Database, eq } from "../../src/storage/db"
import { currentLifecycleCloseAction, directoryKey } from "../../src/session/lifecycle-provenance"
import { disposeAllInstances, tmpdir, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

let bootstrapRun: Effect.Effect<void> = Effect.void
const noopBootstrap = Layer.succeed(
  InstanceBootstrap.Service,
  InstanceBootstrap.Service.of({ run: Effect.suspend(() => bootstrapRun) }),
)

const it = testEffect(
  Layer.mergeAll(InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap)), CrossSpawnSpawner.defaultLayer),
)

afterEach(async () => {
  bootstrapRun = Effect.void
  await disposeAllInstances()
})

describe("InstanceStore", () => {
  it.live("runs bootstrap with InstanceRef provided", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const store = yield* InstanceStore.Service
      let initializedDirectory: string | undefined

      bootstrapRun = Effect.gen(function* () {
        initializedDirectory = (yield* InstanceRef)?.directory
      })
      yield* store.load({ directory: dir })

      expect(initializedDirectory).toBe(dir)
      expect(() => Instance.current).toThrow()
    }),
  )

  it.live("dedupes concurrent loads while bootstrap is in flight", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const store = yield* InstanceStore.Service
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let initialized = 0

      bootstrapRun = Effect.promise(async () => {
        initialized++
        started.resolve()
        await release.promise
      })
      const first = yield* store.load({ directory: dir }).pipe(Effect.forkScoped)

      yield* Effect.promise(() => started.promise)

      bootstrapRun = Effect.sync(() => {
        initialized++
      })
      const second = yield* store.load({ directory: dir }).pipe(Effect.forkScoped)

      expect(initialized).toBe(1)
      release.resolve()

      const [firstCtx, secondCtx] = yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      expect(secondCtx).toBe(firstCtx)
      expect(initialized).toBe(1)
    }),
  )

  it.live("reload replaces the cached context and disposes the previous one", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const store = yield* InstanceStore.Service
      const disposed: Array<string> = []
      const off = registerDisposer(async (directory) => {
        disposed.push(directory)
      })
      yield* Effect.addFinalizer(() => Effect.sync(off))

      const first = yield* store.load({ directory: dir })
      const second = yield* store.reload({ directory: dir })
      const cached = yield* store.load({ directory: dir })

      expect(second).not.toBe(first)
      expect(cached).toBe(second)
      expect(disposed).toEqual([dir])
    }),
  )

  it.live("records worktree mismatch when load reloads an active instance", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const store = yield* InstanceStore.Service
      const reasons: string[] = []
      const off = registerDisposer(async (directory) => {
        const action = currentLifecycleCloseAction(directory)
        if (action?.origin?.reason) reasons.push(action.origin.reason)
      })
      yield* Effect.addFinalizer(() => Effect.sync(off))

      const first = yield* store.load({ directory: dir })
      yield* store.load({
        directory: dir,
        worktree: `${first.worktree}-changed`,
        project: first.project,
      })

      expect(reasons).toContain("worktree_mismatch")
    }),
  )

  it.live("records project row missing when load reloads a stale active instance", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const store = yield* InstanceStore.Service
      const reasons: string[] = []
      const off = registerDisposer(async (directory) => {
        const action = currentLifecycleCloseAction(directory)
        if (action?.origin?.reason) reasons.push(action.origin.reason)
      })
      yield* Effect.addFinalizer(() => Effect.sync(off))

      const first = yield* store.load({ directory: dir })
      yield* Effect.sync(() =>
        Database.use((database) => database.delete(ProjectTable).where(eq(ProjectTable.id, first.project.id)).run()),
      )
      yield* store.load({ directory: dir })

      expect(reasons).toContain("project_row_missing")
    }),
  )

  it.live("disposeDirectory disposes loaded entries without loading missing directories", () =>
    Effect.gen(function* () {
      const loaded = yield* tmpdirScoped()
      const missing = yield* tmpdirScoped()
      const store = yield* InstanceStore.Service
      const disposed: string[] = []
      const off = registerDisposer(async (directory) => {
        disposed.push(directory)
      })
      yield* Effect.addFinalizer(() => Effect.sync(off))

      yield* store.load({ directory: loaded })

      bootstrapRun = Effect.sync(() => {
        throw new Error("disposeDirectory must not bootstrap unloaded directories")
      })
      yield* store.disposeDirectory(missing)
      yield* store.disposeDirectory(loaded)

      expect(disposed).toEqual([loaded])
    }),
  )

  it.live("drops failed loads so the next attempt can boot again", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const store = yield* InstanceStore.Service
      let attempts = 0

      bootstrapRun = Effect.sync(() => {
        attempts++
        throw new Error("boom")
      })
      const failed = yield* store.load({ directory: dir }).pipe(Effect.exit)
      expect(Exit.isFailure(failed)).toBe(true)

      bootstrapRun = Effect.sync(() => {
        attempts++
      })
      yield* store.load({ directory: dir })

      expect(attempts).toBe(2)
    }),
  )

  test("cached legacy instances rehydrate project rows after the database is reopened", async () => {
    await using dir = await tmpdir({ git: true })
    let projectID: Project.Info["id"] | undefined

    await Instance.provide({
      directory: dir.path,
      fn: () => {
        projectID = Instance.project.id
        expect(Project.get(projectID!)).toBeDefined()
      },
    })

    Database.close()

    await Instance.provide({
      directory: dir.path,
      fn: () => {
        expect(Instance.project.id).toBe(projectID!)
        expect(Project.get(projectID!)).toBeDefined()
      },
    })
  })

  test("disposeAll covers instances from every active store runtime", async () => {
    await using first = await tmpdir()
    await using second = await tmpdir()
    const disposed: string[] = []
    const off = registerDisposer(async (directory) => {
      disposed.push(directory)
    })
    const layer = Layer.mergeAll(
      InstanceStore.defaultLayer.pipe(Layer.provide(noopBootstrap)),
      CrossSpawnSpawner.defaultLayer,
    )
    const firstRuntime = ManagedRuntime.make(layer)
    const secondRuntime = ManagedRuntime.make(layer)

    try {
      await firstRuntime.runPromise(InstanceStore.Service.use((store) => store.load({ directory: first.path })))
      await secondRuntime.runPromise(InstanceStore.Service.use((store) => store.load({ directory: second.path })))

      const result = await Instance.disposeAll()

      expect(new Set(disposed)).toEqual(new Set([first.path, second.path]))
      expect(new Set(result.affectedDirectoryKeys)).toEqual(new Set([directoryKey(first.path), directoryKey(second.path)]))
    } finally {
      off()
      await Promise.all([firstRuntime.dispose(), secondRuntime.dispose()])
    }
  })
})
