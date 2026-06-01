import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { validateModelAndVariantWith } from "../../src/automation/validation"
import { ModelNotFoundError, type Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { fakeAutomationProvider, ProviderTest } from "../fake/provider"

function runDetails(provider: Provider.Interface, model: { providerID: string; modelID: string }, variant?: string) {
  return Effect.runPromise(validateModelAndVariantWith(provider, model, variant))
}

describe("automation validation — matches HTTP route 422 details payload", () => {
  test("returns empty details when model exists and variant is supported", async () => {
    const { providerID, modelID, interface: provider } = fakeAutomationProvider()
    expect(await runDetails(provider, { providerID, modelID }, "high")).toEqual([])
  })

  test("returns empty details when variant is omitted", async () => {
    const { providerID, modelID, interface: provider } = fakeAutomationProvider()
    expect(await runDetails(provider, { providerID, modelID })).toEqual([])
  })

  test("rejects unsupported variant for the given model with invalid_variant_for_model", async () => {
    const { providerID, modelID, interface: provider } = fakeAutomationProvider()
    expect(await runDetails(provider, { providerID, modelID }, "xhigh")).toEqual([
      { field: "variant", message: "invalid_variant_for_model" },
    ])
  })

  test("maps ModelNotFoundError to model_not_found", async () => {
    const provider: Provider.Interface = {
      ...fakeAutomationProvider().interface,
      getModel: (pId, mId) =>
        Effect.fail(new ModelNotFoundError({ providerID: pId, modelID: mId })) as never,
    }
    expect(await runDetails(provider, { providerID: "anthropic", modelID: "claude-bogus" })).toEqual([
      { field: "model", message: "model_not_found" },
    ])
  })

  test("maps unknown provider failures to model_lookup_failed", async () => {
    const provider: Provider.Interface = {
      ...fakeAutomationProvider().interface,
      getModel: () => Effect.die(new Error("provider exploded")) as never,
    }
    expect(await runDetails(provider, { providerID: "x", modelID: "y" })).toEqual([
      { field: "model", message: "model_lookup_failed" },
    ])
  })

  test("rejects unsupported variant against a non-reasoning model", async () => {
    const nonReasoning = ProviderTest.model({
      id: ModelID.make("plain-model"),
      providerID: ProviderID.make("openai"),
      capabilities: {
        toolcall: true,
        attachment: false,
        reasoning: false,
        temperature: true,
        interleaved: false,
        input: { text: true, image: false, audio: false, video: false, pdf: false },
        output: { text: true, image: false, audio: false, video: false, pdf: false },
      },
    })
    const provider: Provider.Interface = {
      ...fakeAutomationProvider().interface,
      getModel: () => Effect.succeed(nonReasoning) as never,
    }
    expect(await runDetails(provider, { providerID: "openai", modelID: "plain-model" }, "high")).toEqual([
      { field: "variant", message: "invalid_variant_for_model" },
    ])
  })
})
