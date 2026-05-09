import { AppRuntime } from "@/effect/app-runtime"
import { InstanceStore, type LoadInput } from "./instance-store"

export const load = (input: LoadInput) => AppRuntime.runPromise(InstanceStore.Service.use((store) => store.load(input)))

export const reloadInstance = (input: LoadInput) =>
  AppRuntime.runPromise(InstanceStore.Service.use((store) => store.reload(input)))

export const disposeInstance = (ctx: Parameters<InstanceStore.Interface["dispose"]>[0]) =>
  AppRuntime.runPromise(InstanceStore.Service.use((store) => store.dispose(ctx)))

export const disposeDirectory = (directory: string) =>
  AppRuntime.runPromise(InstanceStore.Service.use((store) => store.disposeDirectory(directory)))

export const disposeAllInstances = () =>
  AppRuntime.runPromise(InstanceStore.Service.use((store) => store.disposeAll()))

export * as InstanceRuntime from "./instance-runtime"
