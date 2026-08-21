import { describe, expect, test, vi } from "vitest"
import { DshLifecycle, type DshLifecycleState } from "./dsh-lifecycle"
import type { DshRun } from "./dsh-sidecar"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function run() {
  const ready = deferred<string>()
  const exited = deferred<number | null>()
  const stop = vi.fn(async () => {})
  return { sidecar: { ready: ready.promise, exited: exited.promise, stop } satisfies DshRun, ready, exited, stop }
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve))
}

describe("DshLifecycle", () => {
  test("stopping during startup owns the spawned run and rejects every late event", async () => {
    const spawned = run()
    const states: DshLifecycleState[] = []
    const lifecycle = new DshLifecycle({ launch: () => spawned.sidecar, onChange: (state) => states.push(state) })

    expect(lifecycle.start()).toBe(true)
    const stopping = lifecycle.stop()
    expect(lifecycle.stop()).toBe(stopping)
    spawned.ready.resolve("http://127.0.0.1:43123")
    spawned.exited.resolve(0)
    await stopping
    await settle()

    expect(spawned.stop).toHaveBeenCalledTimes(1)
    expect(states.map((state) => state.phase)).toEqual(["starting", "stopping", "stopped"])
    expect(lifecycle.url).toBeUndefined()
  })

  test("becomes usable only after the current DSH origin reports a committed product tree", async () => {
    const spawned = run()
    const states: DshLifecycleState[] = []
    const lifecycle = new DshLifecycle({ launch: () => spawned.sidecar, onChange: (state) => states.push(state) })

    lifecycle.start()
    spawned.ready.resolve("http://127.0.0.1:43123")
    await settle()

    expect(lifecycle.productReady("http://127.0.0.1:9/")).toBe(false)
    expect(lifecycle.productReady("http://127.0.0.1:43123/session/new")).toBe(true)
    expect(lifecycle.isReady).toBe(true)
    expect(states.map((state) => state.phase)).toEqual(["starting", "loading", "ready"])
  })

  test("classifies an exit before product readiness as startup failure", async () => {
    const spawned = run()
    const states: DshLifecycleState[] = []
    const lifecycle = new DshLifecycle({ launch: () => spawned.sidecar, onChange: (state) => states.push(state) })

    lifecycle.start()
    spawned.ready.resolve("http://127.0.0.1:43123")
    await settle()
    spawned.exited.resolve(23)
    await settle()

    expect(spawned.stop).toHaveBeenCalledTimes(1)
    expect(states.at(-1)).toMatchObject({ phase: "failed", reason: "startup" })
  })

  test("classifies an exit after product readiness as a crash", async () => {
    const spawned = run()
    const states: DshLifecycleState[] = []
    const lifecycle = new DshLifecycle({ launch: () => spawned.sidecar, onChange: (state) => states.push(state) })

    lifecycle.start()
    spawned.ready.resolve("http://127.0.0.1:43123")
    await settle()
    lifecycle.productReady("http://127.0.0.1:43123/")
    spawned.exited.resolve(null)
    await settle()

    expect(states.at(-1)).toMatchObject({ phase: "failed", reason: "crash" })
  })

  test("starts a fresh run after failure without retaining the old stop barrier", async () => {
    const first = run()
    const second = run()
    const launch = vi.fn()
      .mockReturnValueOnce(first.sidecar)
      .mockReturnValueOnce(second.sidecar)
    const lifecycle = new DshLifecycle({ launch, onChange: () => {} })

    lifecycle.start()
    first.ready.reject(new Error("first launch failed"))
    await settle()
    expect(lifecycle.state.phase).toBe("failed")

    expect(lifecycle.start()).toBe(true)
    second.ready.resolve("http://127.0.0.1:43124")
    await settle()

    expect(launch).toHaveBeenCalledTimes(2)
    expect(lifecycle.url).toBe("http://127.0.0.1:43124")
  })
})
