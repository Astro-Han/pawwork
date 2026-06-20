import z from "zod"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Bus } from "../../src/bus"
import { BusEvent } from "../../src/bus/bus-event"

export function publishBus<D extends BusEvent.Definition>(def: D, properties: z.output<D["properties"]>) {
  return AppRuntime.runPromise(Bus.Service.use((bus) => bus.publish(def, properties)))
}

export function subscribeBus<D extends BusEvent.Definition>(
  def: D,
  callback: (event: { type: D["type"]; properties: z.infer<D["properties"]> }) => unknown,
) {
  return AppRuntime.runSync(Bus.Service.use((bus) => bus.subscribeCallback(def, callback)))
}

export function subscribeAllBus(callback: (event: any) => unknown) {
  return AppRuntime.runSync(Bus.Service.use((bus) => bus.subscribeAllCallback(callback)))
}
