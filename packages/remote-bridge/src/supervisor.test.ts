import { expect, test } from "bun:test"
import { PlatformSupervisor, type PlatformStatus, supervisePlatforms } from "./supervisor.ts"
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
  stops = 0
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
    this.stops++
    this.unblock?.()
    this.unblock = null
  }
}

/** A Platform that blocks in start() until stop() and exposes its onReady so a
 * test can fire readiness on demand (and fire a retired loop's stale callback). */
class ManualPlatform implements Platform {
  starts = 0
  stops = 0
  onReady: () => void = () => {}
  private unblock: (() => void) | null = null
  constructor(readonly name: string) {}
  async start(_handler: MessageHandler, onReady?: () => void): Promise<void> {
    this.starts++
    this.onReady = onReady ?? (() => {})
    return new Promise<void>((resolve) => {
      this.unblock = resolve
    })
  }
  async reply(): Promise<void> {}
  async send(): Promise<void> {}
  async stop(): Promise<void> {
    this.stops++
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

test("a synchronous throw in start() degrades and retries instead of crashing", async () => {
  // A misbehaving adapter whose start() throws synchronously (not a rejected
  // promise). The supervisor must treat it like any failure: degrade and retry.
  let starts = 0
  let unblock: (() => void) | null = null
  const platform: Platform = {
    name: "sync-throw",
    start(_handler: MessageHandler, onReady?: () => void): Promise<void> {
      starts++
      if (starts === 1) throw new Error("sync boom")
      onReady?.()
      return new Promise<void>((resolve) => {
        unblock = resolve
      })
    },
    reply: async () => {},
    send: async () => {},
    stop: async () => {
      unblock?.()
      unblock = null
    },
  }
  const statuses: PlatformStatus[] = []
  const ready: string[] = []
  const controller = new AbortController()

  const supervised = supervisePlatforms([platform], noopHandler, controller.signal, {
    onStatus: (s) => statuses.push(s),
    onPlatformReady: (p) => ready.push(p.name),
    backoffMs: 5,
    maxBackoffMs: 20,
  })

  await waitUntil(() => ready.includes("sync-throw"))
  expect(starts).toBe(2) // first threw, retried, then served
  expect(phasesFor(statuses, "sync-throw")).toEqual(["starting", "degraded", "starting", "serving"])
  expect(statuses.find((s) => s.phase === "degraded")?.error).toBe("sync boom")

  controller.abort()
  await supervised
})

test("a perpetually failing platform does not accumulate abort listeners", async () => {
  // The retry loop now runs on the platform's own child signal, so count "abort"
  // listeners across ALL signals (patch the prototype) rather than just the run
  // signal — the per-attempt race + backoff still register and clean up there.
  let added = 0
  let removed = 0
  const proto = AbortSignal.prototype as unknown as {
    addEventListener: AbortSignal["addEventListener"]
    removeEventListener: AbortSignal["removeEventListener"]
  }
  const realAdd = proto.addEventListener
  const realRemove = proto.removeEventListener
  proto.addEventListener = function (this: AbortSignal, type, ...rest) {
    if (type === "abort") added++
    return (realAdd as (...a: unknown[]) => unknown).call(this, type, ...rest)
  } as AbortSignal["addEventListener"]
  proto.removeEventListener = function (this: AbortSignal, type, ...rest) {
    if (type === "abort") removed++
    return (realRemove as (...a: unknown[]) => unknown).call(this, type, ...rest)
  } as AbortSignal["removeEventListener"]

  const controller = new AbortController()
  try {
    const bad = new ScriptedPlatform("bad", [{ kind: "reject", error: "down" }])
    const supervised = supervisePlatforms([bad], noopHandler, controller.signal, { backoffMs: 1, maxBackoffMs: 2 })

    await waitUntil(() => bad.starts >= 6)
    // Each attempt's race + backoff register an abort listener but clean it up, so
    // the live count stays bounded (one run-signal forwarder + the current phase),
    // not one-per-retry.
    expect(added).toBeGreaterThan(5)
    expect(added - removed).toBeLessThanOrEqual(3)

    controller.abort()
    await supervised
  } finally {
    proto.addEventListener = realAdd
    proto.removeEventListener = realRemove
  }
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

test("PlatformSupervisor.add starts a platform on an already-running supervisor", async () => {
  const controller = new AbortController()
  const ready: string[] = []
  const supervisor = new PlatformSupervisor(noopHandler, controller.signal, {
    onPlatformReady: (platform) => ready.push(platform.name),
    backoffMs: 5,
  })
  supervisor.add(new ScriptedPlatform("first", [{ kind: "serve" }]))
  await waitUntil(() => ready.includes("first"))

  // A second platform added later starts on its own loop, with the first untouched.
  supervisor.add(new ScriptedPlatform("second", [{ kind: "serve" }]))
  await waitUntil(() => ready.includes("second"))
  expect(supervisor.has("first")).toBe(true)
  expect(supervisor.has("second")).toBe(true)

  controller.abort()
  await supervisor.stopAll()
})

test("PlatformSupervisor.remove stops only that platform, leaving the others serving", async () => {
  const controller = new AbortController()
  const ready: string[] = []
  const supervisor = new PlatformSupervisor(noopHandler, controller.signal, {
    onPlatformReady: (platform) => ready.push(platform.name),
    backoffMs: 5,
  })
  const keep = new ScriptedPlatform("keep", [{ kind: "serve" }])
  const drop = new ScriptedPlatform("drop", [{ kind: "serve" }])
  supervisor.add(keep)
  supervisor.add(drop)
  await waitUntil(() => ready.includes("keep") && ready.includes("drop"))

  await supervisor.remove("drop")
  expect(supervisor.has("drop")).toBe(false)
  expect(drop.stops).toBe(1) // the removed platform's loop was stopped
  // The survivor is untouched: still supervised, started once, never stopped.
  expect(supervisor.has("keep")).toBe(true)
  expect(keep.starts).toBe(1)
  expect(keep.stops).toBe(0)

  controller.abort()
  await supervisor.stopAll()
})

test("a retired loop's late ready cannot satisfy a replacement under the same name", async () => {
  // Generation-token guard: after remove + a same-name add, the old loop's late
  // ready must be dropped so it can't be counted as the new entry serving.
  const controller = new AbortController()
  const statuses: PlatformStatus[] = []
  const supervisor = new PlatformSupervisor(noopHandler, controller.signal, { onStatus: (status) => statuses.push(status) })
  const servingCount = () => statuses.filter((status) => status.name === "dupe" && status.phase === "serving").length

  const retired = new ManualPlatform("dupe")
  supervisor.add(retired)
  await waitUntil(() => retired.starts === 1)
  const staleReady = retired.onReady // the retired loop's ready callback

  await supervisor.remove("dupe")
  const fresh = new ManualPlatform("dupe")
  supervisor.add(fresh) // a new entry takes the name, with a new token
  await waitUntil(() => fresh.starts === 1)

  // The replacement serves normally...
  fresh.onReady()
  await waitUntil(() => servingCount() === 1)
  // ...but the retired loop's late ready is ignored, not counted as another serve.
  staleReady()
  expect(servingCount()).toBe(1)

  controller.abort()
  await supervisor.stopAll()
})
