import { describe, expect, test } from "bun:test"
import { selectModel } from "./model-picker-select"

// Guards the recordRecent wiring at the picker's call site: an explicit pick must
// pass { recent: true } so the choice becomes the server's recent-model default —
// what a model-less session (e.g. a Telegram /new) inherits. Dropping the flag
// from selectModel is exactly the regression this catches; a test on the Local
// model.set alone never would, because it bypasses the picker's call site.
describe("model picker selectModel", () => {
  function spy() {
    const calls: Array<{ item: unknown; options: unknown }> = []
    return { set: (item: unknown, options: unknown) => calls.push({ item, options }), calls }
  }

  test("an explicit pick records the recent-model default", () => {
    const model = spy()
    selectModel(model, { id: "claude", provider: { id: "anthropic" } })
    expect(model.calls).toEqual([{ item: { providerID: "anthropic", modelID: "claude" }, options: { recent: true } }])
  })

  test("clearing the selection still routes through as an explicit pick", () => {
    const model = spy()
    selectModel(model, undefined)
    expect(model.calls).toEqual([{ item: undefined, options: { recent: true } }])
  })
})
