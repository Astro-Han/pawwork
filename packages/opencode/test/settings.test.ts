import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Settings } from "../src/settings"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.mergeAll(Settings.defaultLayer))

describe("Settings.Service", () => {
  it.live("lspEnabled defaults to false", () =>
    Effect.gen(function* () {
      const settings = yield* Settings.Service
      // Reset in case a prior test in the suite enabled it (Ref is shared via memoMap).
      yield* settings.setLspEnabled(false)
      expect(yield* settings.lspEnabled()).toBe(false)
    }),
  )

  it.live("setLspEnabled persists across reads", () =>
    Effect.gen(function* () {
      const settings = yield* Settings.Service
      yield* settings.setLspEnabled(true)
      try {
        expect(yield* settings.lspEnabled()).toBe(true)
      } finally {
        yield* settings.setLspEnabled(false)
      }
    }),
  )
})
