import { describe, expect, test } from "bun:test"
import { getRuntimeFlags } from "./runtime-flags"

describe("runtime flags", () => {
  test("ci smoke is enabled only for explicit true", () => {
    expect(getRuntimeFlags({ PAWWORK_CI_SMOKE: "true" }).ciSmokeEnabled).toBe(true)
    expect(getRuntimeFlags({ PAWWORK_CI_SMOKE: "false" }).ciSmokeEnabled).toBe(false)
    expect(getRuntimeFlags({}).ciSmokeEnabled).toBe(false)
  })
})
