import { Context, Data, Effect, Layer } from "effect"
import { Runtime } from "@opencode-ai/shared/runtime"

export namespace ShareRuntime {
  export class CloudShareGate extends Context.Service<CloudShareGate, { isEnabled: () => boolean }>()(
    "@pawwork/CloudShareGate",
  ) {}

  export const cloudShareGateDefaultLayer = Layer.succeed(CloudShareGate, {
    isEnabled: () => !Runtime.isPawWork(),
  })

  // Typed Effect failure (NOT a thrown Error). Using Data.TaggedError + Effect.fail produces
  // a typed failure in the Cause; throwing inside Effect.sync would produce a Cause.Die (defect)
  // and lose the typed-error contract that callers / tests rely on.
  export class CloudShareDisabled extends Data.TaggedError("CloudShareDisabled")<{
    readonly message: string
  }> {}

  export const cloudShareDisabled = () =>
    new CloudShareDisabled({
      message: "Cloud share is disabled in PawWork. Use Export session log instead.",
    })

  // Returns an Effect; callers `yield* ensureEnabled` to surface the typed failure.
  export const ensureEnabled = Effect.gen(function* () {
    const gate = yield* CloudShareGate
    if (gate.isEnabled()) return
    return yield* Effect.fail(cloudShareDisabled())
  })
}
