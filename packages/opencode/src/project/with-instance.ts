import { InstanceRuntime } from "./instance-runtime"
import { context } from "./instance-context"

export async function provide<R>(input: { directory: string; fn: () => R }) {
  const ctx = await InstanceRuntime.load({ directory: input.directory })
  return context.provide(ctx, input.fn)
}

export * as WithInstance from "./with-instance"
