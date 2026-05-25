import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer } from "effect"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { Hono } from "hono"
import { GlobalBus } from "../../src/bus/global"
import { Config } from "../../src/config"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { GlobalRoutes } from "../../src/server/instance/global"
import {
  createLifecycleCloseAction,
  currentLifecycleCloseAction,
  directoryKey,
  lifecycleCloseActionMeta,
  withLifecycleCloseAction,
} from "../../src/session/lifecycle-provenance"
import { SessionRunState } from "../../src/session/run-state"
import { SessionID } from "../../src/session/schema"
import { provideInstance, provideTmpdirInstance, tmpdir, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(CrossSpawnSpawner.defaultLayer, SessionRunState.defaultLayer))

describe("SessionRunState", () => {
  test("keeps overlapping lifecycle actions isolated per directory", async () => {
    const directory = "/tmp/pawwork-lifecycle-overlap"
    const first = createLifecycleCloseAction("instance_reload")
    const second = createLifecycleCloseAction("instance_dispose_all")
    let resolveFirst!: () => void
    let resolveSecond!: () => void

    const firstDone = withLifecycleCloseAction([directory], first, async () => {
      await new Promise<void>((resolve) => {
        resolveFirst = resolve
      })
    })
    const secondDone = withLifecycleCloseAction([directory], second, async () => {
      await new Promise<void>((resolve) => {
        resolveSecond = resolve
      })
    })

    expect(currentLifecycleCloseAction(directory)).toBe(second)
    resolveFirst()
    await firstDone
    expect(currentLifecycleCloseAction(directory)).toBe(second)
    resolveSecond()
    await secondDone
    expect(currentLifecycleCloseAction(directory)).toBeUndefined()
  })

  test("creates immutable lifecycle snapshots with safe affected directory keys", async () => {
    const directory = "/tmp/pawwork-lifecycle-snapshot"
    const action = createLifecycleCloseAction("instance_dispose_directory", {
      affectedDirectories: [directory],
      origin: {
        source: "server_handler",
        operation: "instance.dispose",
        reason: "test_dispose",
      },
    })

    expect(action.initiatedAt).toBeNumber()
    expect(action.initiatedMonotonicMs).toBeNumber()
    expect(action.origin).toEqual({
      source: "server_handler",
      operation: "instance.dispose",
      reason: "test_dispose",
    })
    expect(Object.isFrozen(action.affectedDirectoryKeys)).toBe(true)
    expect(Object.isFrozen(action.origin)).toBe(true)
    expect(action.affectedDirectoryKeys).toHaveLength(1)
    expect(action.affectedDirectoryKeys[0]).toStartWith("dir:")
    expect(action.affectedDirectoryKeys[0]).not.toContain(directory)

    const meta = lifecycleCloseActionMeta(action)
    meta.lifecycleAffectedDirectoryKeys.push("dir:mutated")
    if (meta.lifecycleOrigin) meta.lifecycleOrigin.reason = "mutated"
    expect(action.affectedDirectoryKeys).toHaveLength(1)
    expect(action.origin?.reason).toBe("test_dispose")

    await withLifecycleCloseAction([directory], action, async () => {
      expect(currentLifecycleCloseAction(directory)).toBe(action)
    })

    expect(currentLifecycleCloseAction(directory)).toBeUndefined()
    expect(action.origin?.operation).toBe("instance.dispose")
    expect(action.affectedDirectoryKeys).toHaveLength(1)
  })

  it.live("annotates runner interrupts caused by force instance disposal with lifecycle provenance", () => {
    let captured:
      | {
          source?: string
          reason?: string
          recordedAt?: number
          lifecycleActionID?: string
          lifecycleKind?: string
          lifecycleInitiatedAt?: number
          lifecycleInitiatedMonotonicMs?: number
          lifecycleAffectedDirectoryKeys?: string[]
          lifecycleOrigin?: { source: string; operation?: string; reason?: string }
        }
      | undefined

    return provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const run = yield* SessionRunState.Service
          const fiber = yield* run
            .ensureRunning(
              SessionID.make("ses_run_state_scope"),
              (meta) =>
                Effect.sync(() => {
                  captured = meta
                  return {} as never
                }),
              Effect.never,
            )
            .pipe(Effect.forkChild)

          yield* Effect.sleep("10 millis")
          yield* Effect.promise(() => Instance.dispose({ mode: "force" }))

          const exit = yield* Fiber.await(fiber)
          expect(Exit.isSuccess(exit)).toBe(true)

          expect(captured).toMatchObject({
            source: "session.run_state.scope",
            reason: "scope_closed_without_cancel_meta",
            lifecycleKind: "instance_dispose",
          })
          expect(captured?.lifecycleActionID).toStartWith("lifecycle:instance_dispose:")
          expect(captured?.lifecycleInitiatedAt).toBeNumber()
          expect(captured?.lifecycleInitiatedMonotonicMs).toBeNumber()
          expect(captured?.lifecycleAffectedDirectoryKeys).toEqual([directoryKey(directory)])
          expect(captured?.lifecycleOrigin).toMatchObject({ source: "runtime", operation: "instance.dispose" })
          expect(typeof captured?.recordedAt).toBe("number")
        }),
      { git: true },
    )
  })

  it.live("allows force disposeAll to interrupt multiple in-flight runs", () => {
    const captured = new Map<string, { lifecycleActionID?: string; lifecycleKind?: string } | undefined>()

    return provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const run = yield* SessionRunState.Service
          const firstID = SessionID.make("ses_dispose_all_first")
          const secondID = SessionID.make("ses_dispose_all_second")
          const start = (sessionID: SessionID) =>
            run
              .ensureRunning(
                sessionID,
                (meta) =>
                  Effect.sync(() => {
                    captured.set(sessionID, meta)
                    return {} as never
                  }),
                Effect.never,
              )
              .pipe(Effect.forkChild)

          const firstFiber = yield* start(firstID)
          const secondFiber = yield* start(secondID)

          yield* Effect.sleep("10 millis")
          const result = yield* Effect.promise(() => Instance.disposeAll({ mode: "force" }))

          expect(Exit.isSuccess(yield* Fiber.await(firstFiber))).toBe(true)
          expect(Exit.isSuccess(yield* Fiber.await(secondFiber))).toBe(true)
          expect(result.status).toBe("completed")

          const first = captured.get(firstID)
          const second = captured.get(secondID)
          expect(first).toMatchObject({ lifecycleKind: "instance_dispose_all" })
          expect(second).toMatchObject({ lifecycleKind: "instance_dispose_all" })
          expect(first?.lifecycleActionID).toBe(second?.lifecycleActionID)
          expect(first?.lifecycleActionID).toStartWith("lifecycle:instance_dispose_all:")
        }),
      { git: true },
    )
  })

  it.live("defers global dispose while a run is active", () => {
    let captured: unknown
    let responseBody: unknown
    const seen: { payload: { type: string } }[] = []
    const onEvent = (event: { payload: { type: string } }) => {
      seen.push(event)
    }

    return provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const run = yield* SessionRunState.Service
          const release = yield* Deferred.make<void>()
          const fiber = yield* run
            .ensureRunning(
              SessionID.make("ses_global_dispose_origin"),
              (meta) =>
                Effect.sync(() => {
                  captured = meta
                  return {} as never
                }),
              Deferred.await(release).pipe(Effect.as({} as never)),
            )
            .pipe(Effect.forkChild)

          yield* Effect.sync(() => GlobalBus.on("event", onEvent))
          yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", onEvent)))
          yield* Effect.sleep("10 millis")
          yield* Effect.promise(async () => {
            const app = new Hono().route("/global", GlobalRoutes())
            const response = await app.request("/global/dispose", {
              method: "POST",
              headers: {
                "x-pawwork-client-action-id": "client-global-dispose",
                "x-pawwork-client-action-kind": "global.dispose.button",
              },
            })
            expect(response.status).toBe(200)
            responseBody = await response.json()
          })

          yield* Effect.sleep("20 millis")
          expect(captured).toBeUndefined()
          expect(seen.some((event) => event.payload.type === "global.disposed")).toBe(false)
          yield* Deferred.succeed(release, undefined)
          expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true)
          expect(responseBody).toMatchObject({ status: "deferred" })
          yield* Effect.sleep("20 millis")
          expect(seen.some((event) => event.payload.type === "global.disposed")).toBe(true)
        }),
      { git: true },
    )
  })

  it.live("defers disposeAll across all loaded directories when any directory has an active run", () =>
    Effect.gen(function* () {
      const first = yield* tmpdirScoped({ git: true })
      const second = yield* tmpdirScoped({ git: true })
      const release = yield* Deferred.make<void>()
      let captured: unknown

      const fiber = yield* Effect.gen(function* () {
        const run = yield* SessionRunState.Service
        return yield* run.ensureRunning(
          SessionID.make("ses_dispose_all_global_scope"),
          (meta) =>
            Effect.sync(() => {
              captured = meta
              return {} as never
            }),
          Deferred.await(release).pipe(Effect.as({} as never)),
        )
      }).pipe(provideInstance(first), Effect.forkChild)

      yield* Effect.promise(() =>
        Instance.provide({
          directory: second,
          fn: () => undefined,
        }),
      )

      yield* Effect.sleep("10 millis")
      const result = yield* Effect.promise(() => Instance.disposeAll())
      expect(result.status).toBe("deferred")

      yield* Effect.sleep("20 millis")
      expect(captured).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true)
      yield* Effect.sleep("20 millis")
      expect(Instance.directories()).not.toContain(first)
      expect(Instance.directories()).not.toContain(second)
    }))

  it.live("cleans directory tracking after deferred disposeDirectory completes", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const run = yield* SessionRunState.Service
          const release = yield* Deferred.make<void>()
          const fiber = yield* run
            .ensureRunning(
              SessionID.make("ses_dispose_directory_tracking"),
              () => Effect.succeed({} as never),
              Deferred.await(release).pipe(Effect.as({} as never)),
            )
            .pipe(Effect.forkChild)

          yield* Effect.sleep("10 millis")
          expect(Instance.directories()).toContain(directory)
          yield* Effect.promise(() => Instance.disposeDirectory(directory))
          expect(Instance.directories()).toContain(directory)

          yield* Deferred.succeed(release, undefined)
          expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true)
          yield* Effect.sleep("20 millis")
          expect(Instance.directories()).not.toContain(directory)
        }),
      { git: true },
    ))

  it.live("defers instance reload while a run is active", () => {
    let captured: unknown

    return provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const run = yield* SessionRunState.Service
          const release = yield* Deferred.make<void>()
          const fiber = yield* run
            .ensureRunning(
              SessionID.make("ses_reload_deferred"),
              (meta) =>
                Effect.sync(() => {
                  captured = meta
                  return {} as never
                }),
              Deferred.await(release).pipe(Effect.as({} as never)),
            )
            .pipe(Effect.forkChild)

          yield* Effect.sleep("10 millis")
          yield* Effect.promise(() => Instance.reload({ directory }))

          yield* Effect.sleep("20 millis")
          expect(captured).toBeUndefined()
          yield* Deferred.succeed(release, undefined)
          expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true)
          yield* Effect.gen(function* () {
            const nextRun = yield* SessionRunState.Service
            let started = false
            yield* nextRun.ensureRunning(
              SessionID.make("ses_reload_after_idle"),
              () => Effect.succeed({} as never),
              Effect.sync(() => {
                started = true
                return {} as never
              }),
            )
            expect(started).toBe(true)
          }).pipe(provideInstance(directory))
        }),
      { git: true },
    )
  })

  it.live("blocks new runs while a maintenance close is already in progress", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const disposeStarted = yield* Deferred.make<void>()
          const releaseDispose = yield* Deferred.make<void>()
          const state = Instance.state(
            () => ({ ready: true }),
            async () => {
              Effect.runPromise(Deferred.succeed(disposeStarted, undefined)).catch(() => undefined)
              await Effect.runPromise(Deferred.await(releaseDispose))
            },
          )
          state()

          const disposeFiber = yield* Effect.promise(() => Instance.disposeAll()).pipe(Effect.forkChild)
          yield* Deferred.await(disposeStarted)

          let started = false
          const runFiber = yield* Effect.gen(function* () {
            const run = yield* SessionRunState.Service
            return yield* run.ensureRunning(
              SessionID.make("ses_close_race"),
              () => Effect.succeed({} as never),
              Effect.sync(() => {
                started = true
                return "ran" as never
              }),
            )
          }).pipe(provideInstance(directory), Effect.forkChild)

          yield* Effect.sleep("20 millis")
          expect(started).toBe(false)

          yield* Deferred.succeed(releaseDispose, undefined)
          expect(Exit.isSuccess(yield* Fiber.await(disposeFiber))).toBe(true)
          expect(Exit.isSuccess(yield* Fiber.await(runFiber))).toBe(true)
          expect(started).toBe(true)
        }),
      { git: true },
    ))

  it.live("does not leave an active-run marker when a run is cancelled while waiting for close", () =>
    provideTmpdirInstance(
      (directory) =>
        Effect.gen(function* () {
          const disposeStarted = yield* Deferred.make<void>()
          const releaseDispose = yield* Deferred.make<void>()
          const state = Instance.state(
            () => ({ ready: true }),
            async () => {
              Effect.runPromise(Deferred.succeed(disposeStarted, undefined)).catch(() => undefined)
              await Effect.runPromise(Deferred.await(releaseDispose))
            },
          )
          state()

          const disposeFiber = yield* Effect.promise(() => Instance.disposeAll()).pipe(Effect.forkChild)
          yield* Deferred.await(disposeStarted)

          let started = false
          const runFiber = yield* Effect.gen(function* () {
            const run = yield* SessionRunState.Service
            return yield* run.ensureRunning(
              SessionID.make("ses_close_wait_cancelled"),
              () => Effect.succeed({} as never),
              Effect.sync(() => {
                started = true
                return "ran" as never
              }),
            )
          }).pipe(provideInstance(directory), Effect.forkChild)

          yield* Effect.sleep("20 millis")
          expect(started).toBe(false)
          yield* Fiber.interrupt(runFiber)

          yield* Deferred.succeed(releaseDispose, undefined)
          expect(Exit.isSuccess(yield* Fiber.await(disposeFiber))).toBe(true)

          yield* Effect.promise(() =>
            Instance.provide({
              directory,
              fn: () => undefined,
            }),
          )
          const followUp = yield* Effect.promise(() => Instance.disposeAll())
          expect(followUp.status).toBe("completed")
        }),
      { git: true },
    ))

  it.live("defers Config.update while a run is active", () => {
    let captured: unknown

    return provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const run = yield* SessionRunState.Service
          const release = yield* Deferred.make<void>()
          const fiber = yield* run
            .ensureRunning(
              SessionID.make("ses_config_update_origin"),
              (meta) =>
                Effect.sync(() => {
                  captured = meta
                  return {} as never
                }),
              Deferred.await(release).pipe(Effect.as({} as never)),
            )
            .pipe(Effect.forkChild)

          yield* Effect.sleep("10 millis")
          yield* Effect.promise(() => Config.update({ username: "config-update-origin" }))

          yield* Effect.sleep("20 millis")
          expect(captured).toBeUndefined()
          yield* Deferred.succeed(release, undefined)
          expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true)
        }),
      { git: true },
    )
  })

  it.live("defers Config.invalidate while a run is active", () => {
    let captured: unknown
    const seen: { payload: { type: string } }[] = []
    const onEvent = (event: { payload: { type: string } }) => {
      seen.push(event)
    }

    return provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const run = yield* SessionRunState.Service
          const release = yield* Deferred.make<void>()
          const fiber = yield* run
            .ensureRunning(
              SessionID.make("ses_config_invalidate_origin"),
              (meta) =>
                Effect.sync(() => {
                  captured = meta
                  return {} as never
                }),
              Deferred.await(release).pipe(Effect.as({} as never)),
            )
            .pipe(Effect.forkChild)

          yield* Effect.sync(() => GlobalBus.on("event", onEvent))
          yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", onEvent)))
          yield* Effect.sleep("10 millis")
          const invalidateFiber = yield* Effect.promise(() => Config.invalidate(true)).pipe(Effect.forkChild)

          yield* Effect.sleep("20 millis")
          expect(captured).toBeUndefined()
          expect(seen.some((event) => event.payload.type === "global.disposed")).toBe(false)
          yield* Deferred.succeed(release, undefined)
          expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true)
          expect(Exit.isSuccess(yield* Fiber.await(invalidateFiber))).toBe(true)
          yield* Effect.sleep("20 millis")
          expect(seen.some((event) => event.payload.type === "global.disposed")).toBe(true)
        }),
      { git: true },
    )
  })

  it.live("defers Config.updateGlobal invalidation while a run is active", () => {
    let captured: unknown

    return provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const run = yield* SessionRunState.Service
          const release = yield* Deferred.make<void>()
          const fiber = yield* run
            .ensureRunning(
              SessionID.make("ses_config_update_global_origin"),
              (meta) =>
                Effect.sync(() => {
                  captured = meta
                  return {} as never
                }),
              Deferred.await(release).pipe(Effect.as({} as never)),
            )
            .pipe(Effect.forkChild)

          yield* Effect.sleep("10 millis")
          yield* Effect.promise(async () => {
            await using globalTmp = await tmpdir()
            const previous = Global.Path.config
            ;(Global.Path as { config: string }).config = globalTmp.path
            try {
              await Config.updateGlobal({ username: "config-update-global-origin" })
            } finally {
              ;(Global.Path as { config: string }).config = previous
            }
          })

          yield* Effect.sleep("20 millis")
          expect(captured).toBeUndefined()
          yield* Deferred.succeed(release, undefined)
          expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true)
        }),
      { git: true },
    )
  })
})
