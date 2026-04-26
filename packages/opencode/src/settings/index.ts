import { Context, Effect, Layer, Ref } from "effect"
import { makeRuntime } from "../effect/run-service"

export namespace Settings {
  export interface Interface {
    readonly lspEnabled: () => Effect.Effect<boolean>
    readonly setLspEnabled: (value: boolean) => Effect.Effect<void>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/Settings") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const ref = yield* Ref.make<boolean>(false)
      return Service.of({
        lspEnabled: () => Ref.get(ref),
        setLspEnabled: (value) => Ref.set(ref, value),
      })
    }),
  )

  export const defaultLayer = layer

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export const lspEnabled = async () => runPromise((svc) => svc.lspEnabled())
  export const setLspEnabled = async (value: boolean) => runPromise((svc) => svc.setLspEnabled(value))
}
