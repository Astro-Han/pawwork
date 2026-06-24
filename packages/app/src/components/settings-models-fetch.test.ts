import { describe, expect, test } from "bun:test"
import { mergeFetchedModels } from "./settings-models-fetch"

describe("mergeFetchedModels", () => {
  test("adds only models the provider does not already expose", () => {
    const result = mergeFetchedModels({
      existingModelIDs: ["a"],
      fetched: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
    })
    expect(result).toEqual({ models: { b: { name: "B" } }, addedModelIDs: ["b"], skipped: 1 })
  })

  test("preserves existing config models on re-fetch", () => {
    const result = mergeFetchedModels({
      existingModelIDs: ["x"],
      configModels: { x: { name: "Existing X" } },
      fetched: [{ id: "x", name: "X" }, { id: "y", name: "Y" }],
    })
    expect(result.models).toEqual({ x: { name: "Existing X" }, y: { name: "Y" } })
    expect(result.addedModelIDs).toEqual(["y"])
    expect(result.skipped).toBe(1)
  })

  test("defaults a blank name to the id", () => {
    const result = mergeFetchedModels({ existingModelIDs: [], fetched: [{ id: "model-z", name: "  " }] })
    expect(result.models).toEqual({ "model-z": { name: "model-z" } })
    expect(result.addedModelIDs).toEqual(["model-z"])
  })

  test("dedups repeated fetched ids", () => {
    const result = mergeFetchedModels({
      existingModelIDs: [],
      fetched: [{ id: "dup", name: "first" }, { id: "dup", name: "second" }],
    })
    expect(result.models).toEqual({ dup: { name: "first" } })
    expect(result.addedModelIDs).toEqual(["dup"])
  })

  test("reports the added ids so the caller can hide them by default", () => {
    // The visibility gap (issue #1463): freshly fetched models have no release_date, and the model
    // visibility default treats undated models as visible. The caller relies on addedModelIDs to mark
    // exactly the new models hidden, so a large gateway never floods the picker.
    const result = mergeFetchedModels({
      existingModelIDs: ["a"],
      fetched: [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }],
    })
    expect(result.addedModelIDs).toEqual(["b", "c"])
    expect(Object.keys(result.models)).toEqual(["b", "c"])
  })

  test("adds nothing when every fetched model already exists", () => {
    const result = mergeFetchedModels({
      existingModelIDs: ["a", "b"],
      configModels: { a: { name: "A" } },
      fetched: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
    })
    expect(result.models).toEqual({ a: { name: "A" } })
    expect(result.addedModelIDs).toEqual([])
    expect(result.skipped).toBe(2)
  })
})
