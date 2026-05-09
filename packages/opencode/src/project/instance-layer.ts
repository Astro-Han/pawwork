import { Effect, Layer } from "effect"
import { InstanceStore } from "./instance-store"

const bootstrapLayer = Layer.unwrap(
  Effect.tryPromise({
    try: () => import("./bootstrap").then((bootstrap) => bootstrap.InstanceBootstrap.defaultLayer),
    catch: (cause) => cause,
  }),
)

export const layer = InstanceStore.defaultLayer.pipe(Layer.provideMerge(bootstrapLayer))

export * as InstanceLayer from "./instance-layer"
