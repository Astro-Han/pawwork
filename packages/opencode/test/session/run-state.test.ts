import { describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import {
  createLifecycleCloseAction,
  currentLifecycleCloseAction,
  withLifecycleCloseAction,
} from "../../src/session/lifecycle-provenance"
import { SessionRunState } from "../../src/session/run-state"
import { SessionID } from "../../src/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
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

  it.live("annotates runner interrupts caused by instance disposal with lifecycle provenance", () => {
    let captured:
      | {
          source?: string
          reason?: string
          recordedAt?: number
          lifecycleActionID?: string
          lifecycleKind?: string
        }
      | undefined

    return provideTmpdirInstance(
      () =>
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
})
