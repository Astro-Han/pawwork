import { describe, expect, test } from "bun:test"
import { ModelState } from "./model-state"

const model = { providerID: "deepseek", modelID: "deepseek-chat" }
const other = { providerID: "qwen", modelID: "qwen-max" }

describe("shouldRecordRecent", () => {
  // The pollution guard comes first: only a user's own top-level prompt may seed
  // the global default, or a Telegram /new could inherit an agent's inner model.
  test("skips automation runs", () => {
    expect(ModelState.shouldRecordRecent({ automationID: "auto_1" })).toBe(false)
  })

  test("skips subagent / agent-tool child sessions", () => {
    expect(ModelState.shouldRecordRecent({ parentID: "ses_parent" })).toBe(false)
    expect(ModelState.shouldRecordRecent({ createdByAgentTool: true })).toBe(false)
  })

  test("records a user's own top-level prompt", () => {
    expect(ModelState.shouldRecordRecent({})).toBe(true)
  })
})

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
})
