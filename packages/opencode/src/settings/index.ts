import { Context, Effect, Layer, Ref, Semaphore } from "effect"
import { Storage } from "../storage/storage"

export namespace Settings {
  const STORAGE_KEY = ["settings", "runtime"]
  type Stored = {
    lspEnabled?: boolean
    webSearchEnabled?: boolean
  }

  export interface Interface {
    readonly lspEnabled: () => Effect.Effect<boolean>
    readonly setLspEnabled: (value: boolean) => Effect.Effect<void, Storage.Error>
    readonly webSearchEnabled: () => Effect.Effect<boolean>
    readonly setWebSearchEnabled: (value: boolean) => Effect.Effect<void, Storage.Error>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/Settings") {}

  export const layer: Layer.Layer<Service, never, Storage.Service> = Layer.effect(
    Service,
    Effect.gen(function* () {
      const storage = yield* Storage.Service
      const readStored = storage
        .read<Stored>(STORAGE_KEY)
        .pipe(Effect.catchIf(Storage.NotFoundError.isInstance, () => Effect.succeed({} as Stored)))
      const stored = yield* readStored.pipe(Effect.catch((error) => Effect.die(error)))
      const lspEnabled = yield* Ref.make<boolean>(stored.lspEnabled ?? false)
      const webSearchEnabled = yield* Ref.make<boolean>(stored.webSearchEnabled ?? true)
      const persistLock = yield* Semaphore.make(1)
      const persist = (patch: Stored, apply: Effect.Effect<void>) =>
        persistLock.withPermit(
          Effect.gen(function* () {
            const current = yield* readStored
            yield* storage.write(STORAGE_KEY, { ...current, ...patch })
            yield* apply
          }),
        )
      return Service.of({
        lspEnabled: () => Ref.get(lspEnabled),
        setLspEnabled: (value) => persist({ lspEnabled: value }, Ref.set(lspEnabled, value)),
        webSearchEnabled: () => Ref.get(webSearchEnabled),
        setWebSearchEnabled: (value) => persist({ webSearchEnabled: value }, Ref.set(webSearchEnabled, value)),
      })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(Storage.defaultLayer))
}
