import { describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { Hono } from "hono"
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
import { provideTmpdirInstance, tmpdir } from "../fixture/fixture"
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

  it.live("annotates runner interrupts caused by instance disposal with lifecycle provenance", () => {
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
          yield* Effect.promise(() => Instance.dispose())

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

  it.live("fans out one disposeAll lifecycle action to multiple in-flight runs", () => {
    const captured = new Map<string, { lifecycleActionID?: string; lifecycleKind?: string } | undefined>()

    return provideTmpdirInstance(
      () =>
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
          yield* Effect.promise(() => Instance.disposeAll())

          expect(Exit.isSuccess(yield* Fiber.await(firstFiber))).toBe(true)
          expect(Exit.isSuccess(yield* Fiber.await(secondFiber))).toBe(true)

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

  it.live("annotates global dispose interrupts with request origin", () => {
    let captured:
      | {
          lifecycleKind?: string
          lifecycleOrigin?: { source: string; operation?: string; reason?: string }
        }
      | undefined

    return provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const run = yield* SessionRunState.Service
          const fiber = yield* run
            .ensureRunning(
              SessionID.make("ses_global_dispose_origin"),
              (meta) =>
                Effect.sync(() => {
                  captured = meta
                  return {} as never
                }),
              Effect.never,
            )
            .pipe(Effect.forkChild)

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
          })

          expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true)
          expect(captured).toMatchObject({
            lifecycleKind: "instance_dispose_all",
            lifecycleOrigin: {
              source: "server_handler",
              operation: "instance.disposeAll",
              reason: "global.dispose.button",
            },
            lifecycleRequest: {
              method: "POST",
              path: "/global/dispose",
              source: "renderer",
              client_action: {
                id: "client-global-dispose",
                kind: "global.dispose.button",
              },
            },
          })
        }),
      { git: true },
    )
  })

  it.live("annotates Config.update interrupts with config origin", () => {
    let captured: { lifecycleOrigin?: { source: string; operation?: string; reason?: string } } | undefined

    return provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const run = yield* SessionRunState.Service
          const fiber = yield* run
            .ensureRunning(
              SessionID.make("ses_config_update_origin"),
              (meta) =>
                Effect.sync(() => {
                  captured = meta
                  return {} as never
                }),
              Effect.never,
            )
            .pipe(Effect.forkChild)

          yield* Effect.sleep("10 millis")
          yield* Effect.promise(() => Config.update({ username: "config-update-origin" }))

          expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true)
          expect(captured?.lifecycleOrigin).toMatchObject({
            source: "config",
            operation: "config.update",
            reason: "config.update",
          })
        }),
      { git: true },
    )
  })

  it.live("annotates Config.invalidate interrupts with config origin", () => {
    let captured: { lifecycleOrigin?: { source: string; operation?: string; reason?: string } } | undefined

    return provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const run = yield* SessionRunState.Service
          const fiber = yield* run
            .ensureRunning(
              SessionID.make("ses_config_invalidate_origin"),
              (meta) =>
                Effect.sync(() => {
                  captured = meta
                  return {} as never
                }),
              Effect.never,
            )
            .pipe(Effect.forkChild)

          yield* Effect.sleep("10 millis")
          yield* Effect.promise(() => Config.invalidate(true))

          expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true)
          expect(captured?.lifecycleOrigin).toMatchObject({
            source: "config",
            operation: "config.invalidate",
            reason: "config.invalidate",
          })
        }),
      { git: true },
    )
  })

  it.live("annotates Config.updateGlobal interrupts with config origin", () => {
    let captured: { lifecycleOrigin?: { source: string; operation?: string; reason?: string } } | undefined

    return provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const run = yield* SessionRunState.Service
          const fiber = yield* run
            .ensureRunning(
              SessionID.make("ses_config_update_global_origin"),
              (meta) =>
                Effect.sync(() => {
                  captured = meta
                  return {} as never
                }),
              Effect.never,
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

          expect(Exit.isSuccess(yield* Fiber.await(fiber))).toBe(true)
          expect(captured?.lifecycleOrigin).toMatchObject({
            source: "config",
            operation: "config.updateGlobal",
            reason: "config.updateGlobal",
          })
        }),
      { git: true },
    )
  })
})
