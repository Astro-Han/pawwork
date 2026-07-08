import { afterEach, describe, expect, test } from "bun:test"
import z from "zod"
import { Bus } from "../../src/bus"
import { BusEvent } from "../../src/bus/bus-event"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

const TestEvent = BusEvent.define("test.integration", z.object({ value: z.number() }))

function withInstance(directory: string, fn: () => Promise<void>) {
  return Instance.provide({ directory, fn })
}

function publish<D extends BusEvent.Definition>(def: D, properties: z.output<D["properties"]>) {
  return AppRuntime.runPromise(Bus.Service.use((bus) => bus.publish(def, properties)))
}

function subscribe<D extends BusEvent.Definition>(
  def: D,
  callback: (event: { type: D["type"]; properties: z.infer<D["properties"]> }) => unknown,
) {
  return AppRuntime.runSync(Bus.Service.use((bus) => bus.subscribeCallback(def, callback)))
}

function subscribeAll(callback: (event: any) => unknown) {
  return AppRuntime.runSync(Bus.Service.use((bus) => bus.subscribeAllCallback(callback)))
}

describe("Bus integration: acquireRelease subscriber pattern", () => {
  afterEach(() => Instance.disposeAll())

  test("subscriber via callback facade receives events and cleans up on unsub", async () => {
    await using tmp = await tmpdir()
    const received: number[] = []

    await withInstance(tmp.path, async () => {
      const unsub = subscribe(TestEvent, (evt) => {
        received.push(evt.properties.value)
      })
      await Bun.sleep(10)
      await publish(TestEvent, { value: 1 })
      await publish(TestEvent, { value: 2 })
      await Bun.sleep(10)

      expect(received).toEqual([1, 2])

      unsub()
      await Bun.sleep(10)
      await publish(TestEvent, { value: 3 })
      await Bun.sleep(10)

      expect(received).toEqual([1, 2])
    })
  })

  test("subscribeAll receives events from multiple types", async () => {
    await using tmp = await tmpdir()
    const received: Array<{ type: string; value?: number }> = []

    const OtherEvent = BusEvent.define("test.other", z.object({ value: z.number() }))

    await withInstance(tmp.path, async () => {
      subscribeAll((evt) => {
        received.push({ type: evt.type, value: evt.properties.value })
      })
      await Bun.sleep(10)
      await publish(TestEvent, { value: 10 })
      await publish(OtherEvent, { value: 20 })
      await Bun.sleep(10)
    })

    expect(received).toEqual([
      { type: "test.integration", value: 10 },
      { type: "test.other", value: 20 },
    ])
  })

  test("subscriber cleanup on instance disposal interrupts the stream", async () => {
    await using tmp = await tmpdir()
    const received: number[] = []
    let disposed = false

    await withInstance(tmp.path, async () => {
      subscribeAll((evt) => {
        if (evt.type === Bus.InstanceDisposed.type) {
          disposed = true
          return
        }
        received.push(evt.properties.value)
      })
      await Bun.sleep(10)
      await publish(TestEvent, { value: 1 })
      await Bun.sleep(10)
    })

    await Instance.disposeAll()
    await Bun.sleep(50)

    expect(received).toEqual([1])
    expect(disposed).toBe(true)
  })
})
