import { expect, test } from "bun:test"
import { type PlatformStatus, supervisePlatforms } from "./supervisor.ts"
import type { MessageHandler, Platform } from "./types.ts"

// An outcome the scripted platform replays on each successive start() call; the
// last entry repeats once exhausted.
type Outcome =
  | { kind: "reject"; error: string } // throw without serving
  | { kind: "serve" } // fire onReady, then block until stop()/abort
  | { kind: "resolve" } // fire onReady, then return (event-driven adapter shape)
  | { kind: "double" } // fire onReady twice, then block (misbehaving adapter)
  | { kind: "silent" } // return without ever firing onReady

/** A Platform whose start() behavior is driven by a scripted list of outcomes. */
class ScriptedPlatform implements Platform {
  starts = 0
  readyCalls = 0
  private unblock: (() => void) | null = null

  constructor(
    readonly name: string,
    private readonly outcomes: Outcome[],
  ) {}

  async start(_handler: MessageHandler, onReady?: () => void): Promise<void> {
    const outcome = this.outcomes[Math.min(this.starts, this.outcomes.length - 1)]
    this.starts++
    if (outcome.kind === "reject") throw new Error(outcome.error)
    const fire = () => {
      this.readyCalls++
      onReady?.()
    }
    if (outcome.kind !== "silent") fire()
    if (outcome.kind === "double") fire()
    if (outcome.kind === "resolve") return
    if (outcome.kind === "silent") return
    await new Promise<void>((resolve) => {
      this.unblock = resolve
    })
  }
  async reply(): Promise<void> {}
  async send(): Promise<void> {}
  async stop(): Promise<void> {
    this.unblock?.()
    this.unblock = null
  }
}

const noopHandler: MessageHandler = () => {}

async function waitUntil(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = performance.now()
  while (!cond()) {
    if (performance.now() - start > timeoutMs) throw new Error("waitUntil timed out")
    await new Promise((r) => setTimeout(r, 1))
  }
}

const phasesFor = (statuses: PlatformStatus[], name: string) =>
  statuses.filter((s) => s.name === name).map((s) => s.phase)

test("isolates a failing platform so the others keep serving", async () => {
  const good = new ScriptedPlatform("good", [{ kind: "serve" }])
  const bad = new ScriptedPlatform("bad", [{ kind: "reject", error: "bad token" }])
  const ready: string[] = []
  const controller = new AbortController()

  const supervised = supervisePlatforms([good, bad], noopHandler, controller.signal, {
    onPlatformReady: (p) => ready.push(p.name),
    backoffMs: 5,
    maxBackoffMs: 20,
  })

  // The healthy platform serves; the broken one never blocks the others.
  await waitUntil(() => ready.includes("good"))
  expect(ready).toEqual(["good"])
  // The bad platform keeps being retried under backoff rather than crashing the set.
  await waitUntil(() => bad.starts >= 2)

  controller.abort()
  await supervised // never rejects despite the failing platform
})

test("restarts a platform that fails once, then serves", async () => {
  const flaky = new ScriptedPlatform("flaky", [{ kind: "reject", error: "transient" }, { kind: "serve" }])
  const statuses: PlatformStatus[] = []
  const ready: string[] = []
  const controller = new AbortController()

  const supervised = supervisePlatforms([flaky], noopHandler, controller.signal, {
    onStatus: (s) => statuses.push(s),
    onPlatformReady: (p) => ready.push(p.name),
    backoffMs: 5,
    maxBackoffMs: 20,
  })

  await waitUntil(() => ready.includes("flaky"))
  expect(flaky.starts).toBe(2)
  // The lifecycle reads as a recovery: tried, degraded, retried, now serving.
  expect(phasesFor(statuses, "flaky")).toEqual(["starting", "degraded", "starting", "serving"])
  const degraded = statuses.find((s) => s.phase === "degraded")
  expect(degraded?.error).toBe("transient")

  controller.abort()
  await supervised
})

test("a clean self-stop ends the loop without restarting", async () => {
  // An event-driven adapter that registers its callback and returns is not a
  // failure: the supervisor must not restart it.
  const eventDriven = new ScriptedPlatform("event-driven", [{ kind: "resolve" }])
  const statuses: PlatformStatus[] = []
  const controller = new AbortController()

  const supervised = supervisePlatforms([eventDriven], noopHandler, controller.signal, {
    onStatus: (s) => statuses.push(s),
    backoffMs: 5,
  })

  await waitUntil(() => statuses.some((s) => s.phase === "serving"))
  // Give any erroneous restart a chance to fire, then confirm it did not.
  await new Promise((r) => setTimeout(r, 25))
  expect(eventDriven.starts).toBe(1)
  expect(phasesFor(statuses, "event-driven")).toEqual(["starting", "serving"])

  controller.abort()
  await supervised
})

test("counts readiness once per platform even when an adapter double-fires", async () => {
  const doubleFirer = new ScriptedPlatform("double", [{ kind: "double" }])
  const ready: string[] = []
  const controller = new AbortController()

  const supervised = supervisePlatforms([doubleFirer], noopHandler, controller.signal, {
    onPlatformReady: (p) => ready.push(p.name),
  })

  await waitUntil(() => doubleFirer.readyCalls === 2)
  // Two fires from one platform still count as a single readiness.
  expect(ready).toEqual(["double"])

  controller.abort()
  await supervised
})

test("resolves promptly on abort even while a platform is blocked in start()", async () => {
  const serving = new ScriptedPlatform("serving", [{ kind: "serve" }])
  const statuses: PlatformStatus[] = []
  const controller = new AbortController()

  const supervised = supervisePlatforms([serving], noopHandler, controller.signal, {
    onStatus: (s) => statuses.push(s),
  })

  await waitUntil(() => statuses.some((s) => s.phase === "serving"))
  controller.abort()
  // start() is still blocked, but the supervisor must not wait on it to resolve.
  await supervised
  // Abort is a requested stop, not a degradation.
  expect(statuses.some((s) => s.phase === "degraded")).toBe(false)
})
