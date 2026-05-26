import { describe, expect, test } from "bun:test"
import { RunObservability } from "../../src/session/run-observability"

describe("run observability side-effect boundary", () => {
  test("summarizes provider and external tool boundaries as incomplete proof", () => {
    expect(
      RunObservability.sideEffectBoundarySnapshot({
        providerSearch: { type: "provider" },
        externalLookup: { externalResult: true },
        unknownShape: "tool",
      }),
    ).toMatchObject({
      exposed_tool_count: 3,
      provider_executed_capability_present: true,
      external_boundary_present: true,
      proof_result: "incomplete",
      proof_reason: "provider_executed_capability",
    })
  })
})
