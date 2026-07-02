import path from "path"
import { describe, expect, test } from "bun:test"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Global } from "@opencode-ai/core/global"
import { Effect, Layer } from "effect"
import { testEffect } from "../../test/lib/effect"
import { ModelState } from "./model-state"

const model = { providerID: "deepseek", modelID: "deepseek-chat" }
const other = { providerID: "qwen", modelID: "qwen-max" }

describe("applyRecent", () => {
  test("promotes the model to the front of recent", () => {
    const next = ModelState.applyRecent({ recent: [other] }, model)
    expect(next.recent).toEqual([model, other])
  })

  test("dedupes a model that is already present", () => {
    const next = ModelState.applyRecent({ recent: [other, model] }, model)
    expect(next.recent).toEqual([model, other])
  })

  test("preserves sibling fields (favorite/variant)", () => {
    const next = ModelState.applyRecent({ recent: [], favorite: ["x"], variant: { agent: "fast" } }, model)
    expect(next.favorite).toEqual(["x"])
    expect(next.variant).toEqual({ agent: "fast" })
  })

  test("caps the list at max, keeping the newest", () => {
    const previous = Array.from({ length: 60 }, (_, i) => ({ providerID: "p", modelID: `m${i}` }))
    const next = ModelState.applyRecent({ recent: previous }, model, 50)
    const recent = next.recent as Array<{ providerID: string; modelID: string }>
    expect(recent).toHaveLength(50)
    expect(recent[0]).toEqual(model)
  })

  test("tolerates missing or garbage current contents", () => {
    expect(ModelState.applyRecent(undefined, model).recent).toEqual([model])
    expect(ModelState.applyRecent({ recent: "nope" }, model).recent).toEqual([model])
    expect(ModelState.applyRecent("not an object", model).recent).toEqual([model])
  })

  test("drops malformed old entries so a valid older model is not capped out", () => {
    // cap 2: with the bad entries kept, `other` would fall outside the cap; dropped,
    // it survives. defaultModel() skips malformed entries anyway, so this is pure cleanup.
    const next = ModelState.applyRecent({ recent: [{ providerID: "x" }, "garbage", other] }, model, 2)
    expect(next.recent).toEqual([model, other])
  })
})

describe("ModelState.Service.recordRecent", () => {
  const modelFile = () => path.join(Global.Path.state, "model.json")
  const run = testEffect(Layer.merge(ModelState.defaultLayer, AppFileSystem.defaultLayer))

  const withCleanModelFile = <A, E, R>(body: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      yield* fs.makeDirectory(Global.Path.state, { recursive: true })
      yield* fs.remove(modelFile()).pipe(Effect.ignore)
      yield* Effect.addFinalizer(() => fs.remove(modelFile()).pipe(Effect.ignore))
      return yield* body
    })

  run.live(
    "promotes the model while preserving sibling state on a normal file",
    withCleanModelFile(
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        yield* fs.writeWithDirs(
          modelFile(),
          JSON.stringify({ recent: [other], favorite: ["x"], variant: { agent: "fast" } }),
        )

        const service = yield* ModelState.Service
        yield* service.recordRecent(model)

        const after = JSON.parse(yield* fs.readFileString(modelFile()))
        expect(after.recent[0]).toEqual(model)
        expect(after.favorite).toEqual(["x"])
        expect(after.variant).toEqual({ agent: "fast" })
      }),
    ),
  )

  run.live(
    "creates the file from empty when it is missing (ENOENT)",
    withCleanModelFile(
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        const service = yield* ModelState.Service

        yield* service.recordRecent(model)

        const after = JSON.parse(yield* fs.readFileString(modelFile()))
        expect(after.recent).toEqual([model])
      }),
    ),
  )

  run.live(
    "does NOT overwrite a file it cannot parse, so sibling state survives",
    withCleanModelFile(
      Effect.gen(function* () {
        const fs = yield* AppFileSystem.Service
        yield* fs.writeWithDirs(modelFile(), "{ not valid json")

        const service = yield* ModelState.Service
        yield* service.recordRecent(model)

        expect(yield* fs.readFileString(modelFile())).toBe("{ not valid json")
      }),
    ),
  )
})
