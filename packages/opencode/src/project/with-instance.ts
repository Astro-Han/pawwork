import { InstanceRuntime } from "./instance-runtime"
import { context } from "./instance-context"

// Loads an instance from the shared InstanceStore; cleanup is owned by the
// store, so callers should not spawn unawaited work that outlives this callback.
export async function provide<R>(input: { directory: string; fn: () => R | Promise<R> }) {
  const ctx = await InstanceRuntime.load({ directory: input.directory })
  return context.provide(ctx, input.fn)
}

export * as WithInstance from "./with-instance"
