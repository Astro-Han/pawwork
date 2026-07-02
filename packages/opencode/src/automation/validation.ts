import { Cause, Effect, Exit, Result } from "effect"
import { ModelNotFoundError, Provider } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { ProviderTransform } from "@/provider/transform"
import type { Automation } from "."

function isModelNotFound(cause: Cause.Cause<unknown>): boolean {
  const errorResult = Cause.findError(cause)
  if (Result.isSuccess(errorResult) && ModelNotFoundError.isInstance(errorResult.success)) return true
  const defectResult = Cause.findDefect(cause)
  if (Result.isSuccess(defectResult) && ModelNotFoundError.isInstance(defectResult.success)) return true
  return false
}

type ValidationErrorDetail = Automation.ValidationErrorDetailType

type ModelLike = { providerID: string; modelID: string }

export const validateModelAndVariantWith = (
  provider: Provider.Interface,
  model: ModelLike,
  variant: string | undefined,
): Effect.Effect<ValidationErrorDetail[]> =>
  Effect.gen(function* () {
    const providerID = ProviderID.make(model.providerID)
    const modelID = ModelID.make(model.modelID)
    const exit = yield* provider.getModel(providerID, modelID).pipe(Effect.exit)
    if (Exit.isFailure(exit)) {
      const message = isModelNotFound(exit.cause) ? "model_not_found" : "model_lookup_failed"
      return [{ field: "model", message }]
    }
    if (variant === undefined) return []
    const variants = ProviderTransform.variants(exit.value)
    if (!Object.hasOwn(variants, variant)) {
      return [{ field: "variant", message: "invalid_variant_for_model" }]
    }
    return []
  })

export const validateModelAndVariant = (
  model: Automation.Model,
  variant: string | undefined,
): Effect.Effect<ValidationErrorDetail[], never, Provider.Service> =>
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    return yield* validateModelAndVariantWith(provider, model, variant)
  })
