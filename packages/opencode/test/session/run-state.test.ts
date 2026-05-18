import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import { SessionRunState } from "../../src/session/run-state"
import { SessionID } from "../../src/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.mergeAll(CrossSpawnSpawner.defaultLayer, SessionRunState.defaultLayer))

describe("SessionRunState", () => {
  it.live("annotates runner interrupts caused by the run-state scope closing", () => {
    let captured: { source?: string; reason?: string; recordedAt?: number } | undefined

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
          })
          expect(typeof captured?.recordedAt).toBe("number")
        }),
      { git: true },
    )
  })
})
