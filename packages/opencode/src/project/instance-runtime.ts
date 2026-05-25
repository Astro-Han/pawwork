import { AppRuntime } from "@/effect/app-runtime"
import { InstanceStore, type LifecycleCloseOptions, type LoadInput } from "./instance-store"

export const load = (input: LoadInput) => AppRuntime.runPromise(InstanceStore.Service.use((store) => store.load(input)))

export const reloadInstance = (input: LoadInput & LifecycleCloseOptions) =>
  AppRuntime.runPromise(InstanceStore.Service.use((store) => store.reload(input, undefined, input)))

export const disposeInstance = (ctx: Parameters<InstanceStore.Interface["dispose"]>[0], options?: LifecycleCloseOptions) =>
  AppRuntime.runPromise(InstanceStore.Service.use((store) => store.dispose(ctx, options)))

export const disposeDirectory = (directory: string, options?: LifecycleCloseOptions) =>
  AppRuntime.runPromise(InstanceStore.Service.use((store) => store.disposeDirectory(directory, options)))

export const disposeAllInstances = () =>
  AppRuntime.runPromise(InstanceStore.Service.use((store) => store.disposeAll()))

export * as InstanceRuntime from "./instance-runtime"
