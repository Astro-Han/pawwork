import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { validateModelAndVariantWith } from "../../src/automation/validation"
import { ModelNotFoundError, type Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { fakeAutomationProvider, ProviderTest } from "../fake/provider"
import { it } from "../lib/effect"

describe("automation validation — matches HTTP route 422 details payload", () => {
  it.effect("returns empty details when model exists and variant is supported", () =>
    Effect.gen(function* () {
      const { providerID, modelID, interface: provider } = fakeAutomationProvider()
      const details = yield* validateModelAndVariantWith(provider, { providerID, modelID }, "high")
      expect(details).toEqual([])
    }),
  )

  it.effect("returns empty details when variant is omitted", () =>
    Effect.gen(function* () {
      const { providerID, modelID, interface: provider } = fakeAutomationProvider()
      const details = yield* validateModelAndVariantWith(provider, { providerID, modelID }, undefined)
      expect(details).toEqual([])
    }),
  )

  it.effect("rejects unsupported variant for the given model with invalid_variant_for_model", () =>
    Effect.gen(function* () {
      const { providerID, modelID, interface: provider } = fakeAutomationProvider()
      const details = yield* validateModelAndVariantWith(provider, { providerID, modelID }, "xhigh")
      expect(details).toEqual([{ field: "variant", message: "invalid_variant_for_model" }])
    }),
  )

  it.effect("maps ModelNotFoundError to model_not_found", () =>
    Effect.gen(function* () {
      const provider: Provider.Interface = {
        ...fakeAutomationProvider().interface,
        getModel: ((pId, mId) =>
          Effect.fail(new ModelNotFoundError({ providerID: pId, modelID: mId }))) as Provider.Interface["getModel"],
      }
      const details = yield* validateModelAndVariantWith(provider, { providerID: "anthropic", modelID: "claude-bogus" }, undefined)
      expect(details).toEqual([{ field: "model", message: "model_not_found" }])
    }),
  )

  it.effect("maps unknown provider failures to model_lookup_failed", () =>
    Effect.gen(function* () {
      const provider: Provider.Interface = {
        ...fakeAutomationProvider().interface,
        getModel: (() => Effect.die(new Error("provider exploded"))) as Provider.Interface["getModel"],
      }
      const details = yield* validateModelAndVariantWith(provider, { providerID: "x", modelID: "y" }, undefined)
      expect(details).toEqual([{ field: "model", message: "model_lookup_failed" }])
    }),
  )

  it.effect("rejects unsupported variant against a non-reasoning model", () =>
    Effect.gen(function* () {
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
        getModel: (() => Effect.succeed(nonReasoning)) as Provider.Interface["getModel"],
      }
      const details = yield* validateModelAndVariantWith(provider, { providerID: "openai", modelID: "plain-model" }, "high")
      expect(details).toEqual([{ field: "variant", message: "invalid_variant_for_model" }])
    }),
  )
})
