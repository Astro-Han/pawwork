import { describe, expect } from "bun:test"
import { Duration, Effect } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { it } from "../lib/effect"
import { makeMetadataThrottle } from "../../src/tool/shell-metadata-throttle"

function setup(overrides?: { intervalMillis?: number; byteThreshold?: number }) {
  const emits: string[] = []
  const state = { last: "" }
  const make = makeMetadataThrottle({
    intervalMillis: overrides?.intervalMillis ?? 150,
    byteThreshold: overrides?.byteThreshold ?? 4 * 1024,
    snapshot: () => state.last,
    emit: (output) => Effect.sync(() => emits.push(output)),
  })
  return { emits, state, make }
}

describe("tool.shell metadata throttle", () => {
  it.effect("emits the first chunk synchronously without advancing the clock", () =>
    Effect.gen(function* () {
      const { emits, state, make } = setup()
      const throttle = yield* make
      state.last = "hello"
      yield* throttle.onChunk(5)
      expect(emits).toEqual(["hello"])
    }),
  )

  it.effect("emits immediately when accumulated bytes cross the threshold", () =>
    Effect.gen(function* () {
      const { emits, state, make } = setup({ byteThreshold: 100 })
      const throttle = yield* make
      state.last = "a"
      yield* throttle.onChunk(1) // first chunk flushes immediately
      state.last = "ab"
      yield* throttle.onChunk(50) // 50 < 100, coalesced
      expect(emits).toEqual(["a"])
      state.last = "abc"
      yield* throttle.onChunk(60) // 50 + 60 >= 100, flushes
      expect(emits).toEqual(["a", "abc"])
    }),
  )

  it.effect("flushes coalesced chunks on the interval timer (progressive updates)", () =>
    Effect.gen(function* () {
      const { emits, state, make } = setup()
      const throttle = yield* make
      state.last = "1"
      yield* throttle.onChunk(1) // first flush
      state.last = "12"
      yield* throttle.onChunk(1) // coalesced under threshold
      yield* TestClock.adjust(Duration.millis(150)) // timer flush
      state.last = "123"
      yield* throttle.onChunk(1)
      yield* TestClock.adjust(Duration.millis(150)) // timer flush
      state.last = "1234"
      yield* throttle.onChunk(1)
      yield* TestClock.adjust(Duration.millis(150)) // timer flush
      yield* TestClock.adjust(Duration.millis(150)) // nothing dirty, no flush
      expect(emits).toEqual(["1", "12", "123", "1234"])
      expect(emits.length).toBeGreaterThanOrEqual(3)
    }),
  )

  it.effect("final flush pushes a pending tail chunk", () =>
    Effect.gen(function* () {
      const { emits, state, make } = setup()
      const throttle = yield* make
      state.last = "head"
      yield* throttle.onChunk(1) // first flush
      state.last = "head+tail"
      yield* throttle.onChunk(1) // coalesced, not yet emitted
      yield* throttle.flush("final")
      expect(emits).toEqual(["head", "head+tail"])
    }),
  )

  it.effect("spill flush emits immediately even under the byte threshold", () =>
    Effect.gen(function* () {
      const { emits, state, make } = setup()
      const throttle = yield* make
      state.last = "x"
      yield* throttle.onChunk(1) // first flush
      state.last = "x-spilled"
      yield* throttle.flush("spill")
      expect(emits).toEqual(["x", "x-spilled"])
    }),
  )

  it.effect("timer does not emit when no new output arrived", () =>
    Effect.gen(function* () {
      const { emits, state, make } = setup()
      const throttle = yield* make
      state.last = "a"
      yield* throttle.onChunk(1) // first flush clears dirty
      yield* TestClock.adjust(Duration.millis(150))
      yield* TestClock.adjust(Duration.millis(150))
      expect(emits).toEqual(["a"])
    }),
  )

  it.effect("final flush is a no-op when the latest output was already emitted", () =>
    Effect.gen(function* () {
      const { emits, state, make } = setup()
      const throttle = yield* make
      state.last = "done"
      yield* throttle.onChunk(1) // first flush clears dirty
      yield* throttle.flush("final")
      expect(emits).toEqual(["done"])
    }),
  )

  it.effect("swallows a defect from emit across first-chunk, timer, and final flush", () =>
    Effect.gen(function* () {
      let calls = 0
      const state = { last: "" }
      const throttle = yield* makeMetadataThrottle({
        intervalMillis: 150,
        byteThreshold: 4 * 1024,
        snapshot: () => state.last,
        emit: () => {
          calls += 1
          return Effect.die(new Error("metadata channel boom"))
        },
      })
      state.last = "first"
      yield* throttle.onChunk(1) // first-chunk synchronous flush
      state.last = "first+timer"
      yield* throttle.onChunk(1)
      yield* TestClock.adjust(Duration.millis(150)) // timer flush
      state.last = "first+timer+final"
      yield* throttle.onChunk(1)
      yield* throttle.flush("final") // final flush
      // Reaching here proves none of the three flush paths propagated the defect.
      expect(calls).toBeGreaterThanOrEqual(3)
    }),
  )
})
