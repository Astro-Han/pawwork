import fs from "fs/promises"
import path from "path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Global } from "@opencode-ai/core/global"
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

describe("recordRecent", () => {
  // Global.Path.state is the process-wide state dir (isolated per test process by
  // the XDG override in test/preload.ts). Clear model.json around each test.
  const modelFile = () => path.join(Global.Path.state, "model.json")

  beforeEach(async () => {
    await fs.mkdir(Global.Path.state, { recursive: true })
    await fs.rm(modelFile(), { force: true })
  })
  afterEach(async () => await fs.rm(modelFile(), { force: true }))

  test("promotes the model while preserving sibling state on a normal file", async () => {
    await fs.writeFile(modelFile(), JSON.stringify({ recent: [other], favorite: ["x"], variant: { agent: "fast" } }))
    await ModelState.recordRecent(model)
    const after = JSON.parse(await fs.readFile(modelFile(), "utf8"))
    expect(after.recent[0]).toEqual(model)
    expect(after.favorite).toEqual(["x"])
    expect(after.variant).toEqual({ agent: "fast" })
  })

  test("creates the file from empty when it is missing (ENOENT)", async () => {
    await ModelState.recordRecent(model)
    const after = JSON.parse(await fs.readFile(modelFile(), "utf8"))
    expect(after.recent).toEqual([model])
  })

  test("does NOT overwrite a file it cannot parse, so sibling state survives", async () => {
    // A non-ENOENT read failure (here, corrupt JSON) must skip the write rather
    // than clobber a file that may still hold favorite/variant under the damage.
    await fs.writeFile(modelFile(), "{ not valid json")
    await ModelState.recordRecent(model)
    expect(await fs.readFile(modelFile(), "utf8")).toBe("{ not valid json")
  })

  test("writes atomically under concurrency: valid file, no temp residue", async () => {
    // The atomic temp+rename path: many concurrent records must leave a complete,
    // parseable model.json (an unlocked reader never sees a half-written file) and
    // clean up every temp file.
    await Promise.all(Array.from({ length: 30 }, (_, i) => ModelState.recordRecent({ providerID: "p", modelID: `m${i}` })))

    const parsed = JSON.parse(await fs.readFile(modelFile(), "utf8"))
    expect(Array.isArray(parsed.recent)).toBe(true)
    expect(parsed.recent.length).toBeGreaterThan(0)

    const residue = (await fs.readdir(Global.Path.state)).filter((f) => f.startsWith("model.json.") && f.endsWith(".tmp"))
    expect(residue).toEqual([])
  })
})
