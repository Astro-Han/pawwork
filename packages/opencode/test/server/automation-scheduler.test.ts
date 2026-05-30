import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Automation } from "../../src/automation"
import { AutomationScheduler } from "../../src/automation/scheduler"
import { Instance } from "../../src/project/instance"
import { ProjectID } from "../../src/project/schema"
import { trackActiveRun } from "../../src/session/lifecycle-provenance"
import { MessageID, SessionID } from "../../src/session/schema"
import { createAutomateDefinition } from "../../src/tool/automate"
import { tmpdir } from "../fixture/fixture"
import { Flock } from "../../src/util/flock"

afterEach(async () => {
  await Instance.disposeAll()
})

class FakeClock implements AutomationScheduler.Clock {
  private sleepers = new Map<number, { at: number; resolve: () => void }>()
  private nextID = 1

  constructor(private current: number) {}

  now() {
    return this.current
  }

  sleep(delayMs: number, signal: AbortSignal) {
    return new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve()
        return
      }
      const id = this.nextID++
      this.sleepers.set(id, { at: this.current + Math.max(0, delayMs), resolve })
      signal.addEventListener(
        "abort",
        () => {
          this.sleepers.delete(id)
          resolve()
        },
        { once: true },
      )
    })
  }

  async flush() {
    await Bun.sleep(0)
  }

  async advance(ms: number) {
    await this.flush()
    const target = this.current + ms
    while (true) {
      const next = [...this.sleepers.entries()]
        .filter(([, sleeper]) => sleeper.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0]
      if (!next) break
      const [id, sleeper] = next
      this.sleepers.delete(id)
      this.current = sleeper.at
      sleeper.resolve()
      await this.flush()
    }
    this.current = target
  }

  jumpTo(current: number) {
    this.current = current
  }
}

class OversleepClock implements AutomationScheduler.Clock {
  private current: number

  constructor(
    start: number,
    private readonly oversleptAt: number,
  ) {
    this.current = start
  }

  now() {
    return this.current
  }

  sleep(_delayMs: number, signal: AbortSignal) {
    return new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve()
        return
      }
      queueMicrotask(() => {
        this.current = this.oversleptAt
        resolve()
      })
    })
  }
}

class ManualRuntime implements AutomationScheduler.TaskRuntime {
  private queued: Array<{ run: (signal: AbortSignal) => Effect.Effect<void>; controller: AbortController }> = []

  fork(run: (signal: AbortSignal) => Effect.Effect<void>): AutomationScheduler.Task {
    const controller = new AbortController()
    this.queued.push({ run, controller })
    return {
      interrupt() {
        controller.abort()
      },
    }
  }

  start(index: number) {
    const queued = this.queued[index]
    if (!queued) throw new Error(`Missing queued task: ${index}`)
    Effect.runFork(queued.run(queued.controller.signal))
  }
}

async function withAutomation<T>(fn: (projectID: ProjectID) => Promise<T>) {
  await using tmp = await tmpdir({ git: true })
  return Instance.provide({
    directory: tmp.path,
    fn: () => fn(Instance.project.id),
  })
}

function oneshotInput(projectID: ProjectID, fireAt: number): Automation.CreateInput {
  return {
    kind: "oneshot",
    title: "One-time repo brief",
    prompt: "Summarize repo changes once.",
    context: "fresh",
    where: { projectID },
    timezone: "Asia/Shanghai",
    fireAt,
  }
}

type RecurringInput = Extract<Automation.CreateInput, { kind: "recurring" }>

function recurringInput(projectID: ProjectID, everyMs: number, overrides: Partial<RecurringInput> = {}): RecurringInput {
  return {
    kind: "recurring",
    title: "Repo brief",
    prompt: "Summarize repo changes.",
    context: "fresh",
    where: { projectID },
    timezone: "Asia/Shanghai",
    rhythm: { kind: "interval", everyMs },
    stop: { kind: "never" },
    ...overrides,
  }
}

function cronInput(projectID: ProjectID, expression: string, overrides: Partial<RecurringInput> = {}): RecurringInput {
  return recurringInput(projectID, 60_000, {
    rhythm: { kind: "cron", expression },
    timezone: "UTC",
    stop: { kind: "never" },
    ...overrides,
  })
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function waitForRunStates(automationID: string, states: Automation.Run["state"][]) {
  const deadline = Date.now() + 3_000
  let latest: Automation.Run[] = []
  while (Date.now() < deadline) {
    const items = Automation.runs({ automationID }).items
    latest = items
    if (items.length >= states.length && states.every((state, index) => items[index]?.state === state)) return items
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for automation run states: ${states.join(", ")}; latest=${JSON.stringify(latest)}`)
}

function allRuns(automationID: string) {
  const items: Automation.Run[] = []
  let cursor: string | undefined
  while (true) {
    const page = Automation.runs({ automationID, limit: 100, cursor })
    items.push(...page.items)
    if (!page.nextCursor) return items
    cursor = page.nextCursor
  }
}

async function waitForRunCount(automationID: string, count: number) {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const items = allRuns(automationID)
    if (items.length >= count) return items
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for automation run count: ${count}`)
}

async function waitForStarts(starts: unknown[], count: number) {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (starts.length >= count) return
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for scheduler starts: ${count}`)
}

async function waitForSignal(input: () => AbortSignal | undefined) {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const signal = input()
    if (signal) return signal
    await Bun.sleep(5)
  }
  throw new Error("Timed out waiting for run signal")
}

describe("automation scheduler", () => {
  test("fires a one-shot automation once with unattended execution", async () => {
    await withAutomation(async (projectID) => {
      const clock = new FakeClock(0)
      const attendance: string[] = []
      const scheduler = AutomationScheduler.make({
        clock,
        executor: async (input) => {
          attendance.push(input.attendance)
          return { sessionID: SessionID.descending(), result: "done", cost: 0 }
        },
      })
      const definition = Automation.create(oneshotInput(projectID, 1_000), { now: 0 })

      scheduler.reschedule(definition)
      await clock.advance(999)
      expect(Automation.runs({ automationID: definition.id }).items).toHaveLength(0)

      await clock.advance(1)
      const runs = await waitForRunStates(definition.id, ["succeeded"])

      expect(runs).toHaveLength(1)
      expect(runs[0].triggeredAt).toBe(1_000)
      expect(attendance).toEqual(["unattended"])
      await clock.advance(10_000)
      expect(Automation.runs({ automationID: definition.id }).items).toHaveLength(1)
      scheduler.stop()
    })
  })

  test("schedules existing automations when the scheduler starts", async () => {
    await withAutomation(async (projectID) => {
      const clock = new FakeClock(0)
      const calls: number[] = []
      Automation.create(oneshotInput(projectID, 1_000), { now: 0 })

      const scheduler = AutomationScheduler.make({
        clock,
        executor: async () => {
          calls.push(clock.now())
          return { sessionID: SessionID.descending(), result: "done", cost: 0 }
        },
      })

      await clock.advance(1_000)
      await waitForStarts(calls, 1)
      expect(calls).toEqual([1_000])
      scheduler.stop()
    })
  })

  test("schedules recurring automations created through the automate tool", async () => {
    await withAutomation(async (projectID) => {
      const clock = new FakeClock(0)
      const scheduler = AutomationScheduler.make({
        clock,
        executor: async () => ({ sessionID: SessionID.descending(), result: "done", cost: 0 }),
      })
      const tool = createAutomateDefinition()

      const result = await Effect.runPromise(
        tool.execute(
          recurringInput(projectID, 60_000),
          {
            sessionID: SessionID.descending(),
            messageID: MessageID.ascending(),
            agent: "build",
            abort: new AbortController().signal,
            messages: [],
            metadata: () => Effect.void,
            ask: () => Effect.void,
          },
        ),
      )

      const definition = result.metadata.automationDefinition
      await clock.advance(60_000)
      const runs = await waitForRunStates(definition.id, ["succeeded"])

      expect(runs).toHaveLength(1)
      expect(runs[0].triggeredAt).toBe(60_000)
      scheduler.stop()
    })
  })

  test("computes cron next fires on wall-clock time instead of interval completion time", async () => {
    await withAutomation(async (projectID) => {
      const scheduler = AutomationScheduler.make()
      const definition = Automation.create(cronInput(projectID, "0 9 * * *"), {
        now: Date.UTC(2026, 4, 30, 8, 30),
      })

      const next = scheduler.computeNextFireAt(definition, Date.UTC(2026, 4, 30, 8, 30))

      expect(next).toBe(Date.UTC(2026, 4, 30, 9, 0))
      scheduler.stop()
    })
  })

  test("computes cron day-of-month and day-of-week as standard crontab OR semantics", async () => {
    await withAutomation(async (projectID) => {
      const scheduler = AutomationScheduler.make()
      const definition = Automation.create(cronInput(projectID, "0 9 1 * 1"), {
        now: Date.UTC(2026, 5, 2, 8, 0),
      })

      const next = scheduler.computeNextFireAt(definition, Date.UTC(2026, 5, 2, 8, 0))

      expect(next).toBe(Date.UTC(2026, 5, 8, 9, 0))
      scheduler.stop()
    })
  })

  test("allows restricted weekdays to provide a fallback for impossible month days", async () => {
    await withAutomation(async (projectID) => {
      const scheduler = AutomationScheduler.make()
      const definition = Automation.create(cronInput(projectID, "0 9 31 2 1"), {
        now: Date.UTC(2026, 1, 1, 8, 0),
      })

      const next = scheduler.computeNextFireAt(definition, Date.UTC(2026, 1, 1, 8, 0))

      expect(next).toBe(Date.UTC(2026, 1, 2, 9, 0))
      scheduler.stop()
    })
  })

  test("computes cron single-value step expressions from the single-value start", async () => {
    await withAutomation(async (projectID) => {
      const scheduler = AutomationScheduler.make()
      const definition = Automation.create(cronInput(projectID, "5/15 9 * * *"), {
        now: Date.UTC(2026, 4, 30, 9, 0),
      })

      const next = scheduler.computeNextFireAt(definition, Date.UTC(2026, 4, 30, 9, 0))

      expect(next).toBe(Date.UTC(2026, 4, 30, 9, 5))
      scheduler.stop()
    })
  })

  test("computes cron next fires across a leap-year cycle", async () => {
    await withAutomation(async (projectID) => {
      const scheduler = AutomationScheduler.make()
      const definition = Automation.create(cronInput(projectID, "0 0 29 2 *"), {
        now: Date.UTC(2026, 2, 1, 0, 0),
      })

      const next = scheduler.computeNextFireAt(definition, Date.UTC(2026, 2, 1, 0, 0))

      expect(next).toBe(Date.UTC(2028, 1, 29, 0, 0))
      scheduler.stop()
    })
  })

  test("reschedules pending cron timers when timezone changes", async () => {
    await withAutomation(async (projectID) => {
      const clock = new FakeClock(Date.UTC(2024, 4, 30, 8, 30))
      const starts: number[] = []
      const scheduler = AutomationScheduler.make({
        clock,
        executor: async () => {
          starts.push(clock.now())
          return { sessionID: SessionID.descending(), result: "done", cost: 0 }
        },
      })
      const definition = Automation.create(cronInput(projectID, "0 9 * * *"), {
        now: Date.UTC(2024, 4, 30, 8, 30),
      })

      scheduler.reschedule(definition)
      const updated = Automation.update(definition.id, { timezone: "America/New_York" }, { now: clock.now() })
      scheduler.reschedule(updated)

      await clock.advance(30 * 60_000)
      expect(starts).toEqual([])

      await clock.advance(4 * 60 * 60_000)
      await waitForRunStates(definition.id, ["succeeded"])
      expect(starts).toEqual([Date.UTC(2024, 4, 30, 13, 0)])
      scheduler.stop()
    })
  })

  test("records a missed cron fire after scheduler downtime", async () => {
    await withAutomation(async (projectID) => {
      const createdAt = Date.UTC(2026, 4, 30, 8, 30)
      const missedAt = Date.UTC(2026, 4, 30, 9, 0)
      const resumedAt = Date.UTC(2026, 4, 30, 9, 5)
      const clock = new FakeClock(createdAt)
      const starts: number[] = []
      const definition = Automation.create(cronInput(projectID, "0 9 * * *"), { now: createdAt })

      clock.jumpTo(resumedAt)
      const scheduler = AutomationScheduler.make({
        clock,
        executor: async () => {
          starts.push(clock.now())
          return { sessionID: SessionID.descending(), result: "done", cost: 0 }
        },
      })
      const runs = await waitForRunCount(definition.id, 1)

      expect(starts).toEqual([])
      expect(runs[0]).toMatchObject({
        state: "stopped",
        stopReason: "missed_schedule",
        triggeredAt: missedAt,
        completedAt: resumedAt,
      })
      scheduler.stop()
    })
  })

  test("does not cancel a due cron fire during owner rescan", async () => {
    await withAutomation(async (projectID) => {
      const clock = new FakeClock(0)
      const starts: number[] = []
      const scheduler = AutomationScheduler.make({
        clock,
        executor: async () => {
          starts.push(clock.now())
          return { sessionID: SessionID.descending(), result: "done", cost: 0 }
        },
      })
      const definition = Automation.create(cronInput(projectID, "* * * * *"), { now: 0 })

      scheduler.reschedule(definition)
      clock.jumpTo(60_000)
      scheduler.reschedule(definition)
      await clock.advance(0)
      await waitForRunStates(definition.id, ["succeeded"])

      expect(starts).toEqual([60_000])
      scheduler.stop()
    })
  })

  test("does not run timers while another owner holds the durable scheduler lock", async () => {
    await withAutomation(async (projectID) => {
      const key = `automation-scheduler-test-${Date.now()}-${Math.random()}`
      await using lease = await Flock.acquire(key)
      const clock = new FakeClock(0)
      const calls: number[] = []
      const scheduler = AutomationScheduler.make({
        clock,
        ownerKey: key,
        ownerRetryMs: 60_000,
        executor: async () => {
          calls.push(clock.now())
          return { sessionID: SessionID.descending(), result: "done", cost: 0 }
        },
      })
      const definition = Automation.create(oneshotInput(projectID, 1_000), { now: 0 })

      scheduler.reschedule(definition)
      await clock.advance(1_000)

      expect(calls).toEqual([])
      expect(Automation.runs({ automationID: definition.id }).items).toEqual([])
      scheduler.stop()
    })
  })

  test("does not reschedule a one-shot automation after its fire time has run", async () => {
    await withAutomation(async (projectID) => {
      const clock = new FakeClock(0)
      const calls: number[] = []
      const scheduler = AutomationScheduler.make({
        clock,
        executor: async () => {
          calls.push(clock.now())
          return { sessionID: SessionID.descending(), result: "done", cost: 0 }
        },
      })
      const definition = Automation.create(oneshotInput(projectID, 1_000), { now: 0 })

      scheduler.reschedule(definition)
      await clock.advance(1_000)
      await waitForRunStates(definition.id, ["succeeded"])
      scheduler.reschedule(definition)
      await clock.advance(0)

      expect(calls).toEqual([1_000])
      scheduler.stop()
    })
  })

  test("does not rerun a completed one-shot automation after update or pause resume", async () => {
    await withAutomation(async (projectID) => {
      const clock = new FakeClock(0)
      const calls: number[] = []
      const scheduler = AutomationScheduler.make({
        clock,
        executor: async () => {
          calls.push(clock.now())
          return { sessionID: SessionID.descending(), result: "done", cost: 0 }
        },
      })
      const definition = Automation.create(oneshotInput(projectID, 1_000), { now: 0 })

      scheduler.reschedule(definition)
      await clock.advance(1_000)
      await waitForRunStates(definition.id, ["succeeded"])

      const renamed = Automation.update(definition.id, { title: "Updated one-shot" }, { now: 2_000 })
      scheduler.reschedule(renamed)
      const paused = Automation.update(definition.id, { paused: true }, { now: 3_000 })
      scheduler.reschedule(paused)
      const resumed = Automation.update(definition.id, { paused: false }, { now: 4_000 })
      scheduler.reschedule(resumed)
      await clock.advance(0)

      expect(calls).toEqual([1_000])
      expect(Automation.runs({ automationID: definition.id }).items).toHaveLength(1)
      scheduler.stop()
    })
  })

  test("ignores deleted automations when a stale timer fires", async () => {
    await withAutomation(async (projectID) => {
      const clock = new FakeClock(0)
      const calls: number[] = []
      const scheduler = AutomationScheduler.make({
        clock,
        executor: async () => {
          calls.push(clock.now())
          return { sessionID: SessionID.descending(), result: "done", cost: 0 }
        },
      })
      const definition = Automation.create(oneshotInput(projectID, 1_000), { now: 0 })

      scheduler.reschedule(definition)
      await Automation.remove(definition.id)
      await expect(clock.advance(1_000)).resolves.toBeUndefined()

      expect(calls).toEqual([])
      scheduler.stop()
    })
  })

  test("keeps recurring automation scheduled after an active manual run blocks a fire", async () => {
    await withAutomation(async (projectID) => {
      const clock = new FakeClock(0)
      const releaseManual = deferred<{ sessionID: SessionID; result: string | null; cost?: number | null }>()
      const schedulerStarts: number[] = []
      const definition = Automation.create(recurringInput(projectID, 60_000), { now: 0 })
      const scheduler = AutomationScheduler.make({
        clock,
        executor: async () => {
          schedulerStarts.push(clock.now())
          return { sessionID: SessionID.descending(), result: "scheduled", cost: 0 }
        },
      })
      await Automation.runNowExecuting(definition.id, {
        now: 0,
        executor: async () => releaseManual.promise,
      })
      await waitForRunStates(definition.id, ["scheduled"])

      scheduler.reschedule(definition)
      await clock.advance(60_000)
      await waitForRunStates(definition.id, ["stopped", "scheduled"])

      releaseManual.resolve({ sessionID: SessionID.descending(), result: "manual", cost: 0 })
      await waitForRunStates(definition.id, ["stopped", "succeeded"])
      await clock.advance(60_000)
      await waitForRunStates(definition.id, ["succeeded", "stopped", "succeeded"])

      expect(schedulerStarts).toEqual([120_000])
      scheduler.stop()
    })
  })

  test("stops an active scheduled run when scheduler stops", async () => {
    await withAutomation(async (projectID) => {
      const clock = new FakeClock(0)
      const sessionID = SessionID.descending()
      const started = deferred<void>()
      const aborted = deferred<void>()
      let sawAbort = false
      const scheduler = AutomationScheduler.make({
        clock,
        executor: async ({ run, signal }) => {
          const running = Automation.markRunStarted(run, sessionID, { now: clock.now() })
          await Automation.publishRunUpdated(running)
          signal.addEventListener("abort", () => {
            sawAbort = true
            aborted.resolve()
          })
          started.resolve()
          await aborted.promise
          return { sessionID, result: "should not complete", cost: 0 }
        },
      })
      const definition = Automation.create(oneshotInput(projectID, 1_000), { now: 0 })

      scheduler.reschedule(definition)
      await clock.advance(1_000)
      await started.promise

      scheduler.stop()
      const runs = await waitForRunStates(definition.id, ["stopped"])

      expect(sawAbort).toBe(true)
      expect(runs[0]).toMatchObject({
        state: "stopped",
        sessionID,
        stopReason: "cancelled",
      })
    })
  })

  test("stops an active scheduled run when the instance is disposed", async () => {
    await withAutomation(async (projectID) => {
      const clock = new FakeClock(0)
      const releaseRun = deferred<{ sessionID: SessionID; result: string | null; cost?: number | null }>()
      let runSignal: AbortSignal | undefined
      const scheduler = AutomationScheduler.make({
        clock,
        executor: async (input) => {
          runSignal = input.signal
          return releaseRun.promise
        },
      })
      AutomationScheduler.install(scheduler)
      const definition = Automation.create(recurringInput(projectID, 60_000), { now: 0 })

      scheduler.reschedule(definition)
      await clock.advance(60_000)
      await waitForRunStates(definition.id, ["scheduled"])
      expect((await waitForSignal(() => runSignal)).aborted).toBe(false)

      await Instance.dispose({ mode: "force" })

      expect(runSignal?.aborted).toBe(true)
      releaseRun.resolve({ sessionID: SessionID.descending(), result: "done", cost: 0 })
    })
  })

  test("stops an active scheduled run before maintenance dispose waits for other active runs", async () => {
    await withAutomation(async (projectID) => {
      const clock = new FakeClock(0)
      const releaseRun = deferred<{ sessionID: SessionID; result: string | null; cost?: number | null }>()
      let runSignal: AbortSignal | undefined
      const scheduler = AutomationScheduler.make({
        clock,
        executor: async (input) => {
          runSignal = input.signal
          return releaseRun.promise
        },
      })
      AutomationScheduler.install(scheduler)
      const definition = Automation.create(recurringInput(projectID, 60_000), { now: 0 })
      const unrelatedActiveRun = trackActiveRun(Instance.directory)
      const releaseUnrelatedRun = await unrelatedActiveRun.promise

      scheduler.reschedule(definition)
      await clock.advance(60_000)
      await waitForRunStates(definition.id, ["scheduled"])
      expect((await waitForSignal(() => runSignal)).aborted).toBe(false)

      await Instance.dispose()

      expect(runSignal?.aborted).toBe(true)
      releaseRun.resolve({ sessionID: SessionID.descending(), result: "done", cost: 0 })

      const nextDefinition = Automation.create(recurringInput(projectID, 60_000, { title: "Next recurring" }), {
        now: 60_000,
      })
      scheduler.reschedule(nextDefinition)
      await clock.advance(60_000)
      await waitForRunStates(nextDefinition.id, ["succeeded"])

      releaseUnrelatedRun()
      await Bun.sleep(0)
    })
  })

  test("continues maintenance dispose if scheduler pre-stop fails", async () => {
    await withAutomation(async () => {
      AutomationScheduler.install({
        stop: () => undefined,
        stopOwnedRuns: () => {
          throw new Error("pre-stop failed")
        },
        settleOwner: async () => undefined,
        reschedule: () => undefined,
        cancel: () => undefined,
        computeNextFireAt: () => null,
      })

      await expect(Instance.dispose()).resolves.toBeUndefined()
    })
  })

  test("anchors recurring schedule after a long manual run completes", async () => {
    await withAutomation(async (projectID) => {
      const clock = new FakeClock(0)
      const releaseManual = deferred<{ sessionID: SessionID; result: string | null; cost?: number | null }>()
      const schedulerStarts: number[] = []
      const definition = Automation.create(recurringInput(projectID, 60_000), { now: 0 })
      const scheduler = AutomationScheduler.make({
        clock,
        executor: async () => {
          schedulerStarts.push(clock.now())
          return { sessionID: SessionID.descending(), result: "scheduled", cost: 0 }
        },
      })
      await Automation.runNowExecuting(definition.id, {
        now: 0,
        executor: async () => releaseManual.promise,
      })
      await waitForRunStates(definition.id, ["scheduled"])

      scheduler.reschedule(definition)
      await clock.advance(60_000)
      await waitForRunStates(definition.id, ["stopped", "scheduled"])

      await clock.advance(59_000)
      releaseManual.resolve({ sessionID: SessionID.descending(), result: "manual", cost: 0 })
      await waitForRunStates(definition.id, ["stopped", "succeeded"])

      await clock.advance(999)
      expect(schedulerStarts).toEqual([])

      await clock.advance(59_000)
      expect(schedulerStarts).toEqual([])

      await clock.advance(1)
      await waitForRunStates(definition.id, ["succeeded", "stopped", "succeeded"])
      expect(schedulerStarts).toEqual([179_000])
      scheduler.stop()
    })
  })

  test("anchors interval automation after completion and never overlaps", async () => {
    await withAutomation(async (projectID) => {
      const clock = new FakeClock(0)
      const releaseFirst = deferred<void>()
      const starts: number[] = []
      const scheduler = AutomationScheduler.make({
        clock,
        executor: async () => {
          starts.push(clock.now())
          if (starts.length === 1) await releaseFirst.promise
          return { sessionID: SessionID.descending(), result: "done", cost: 0 }
        },
      })
      const definition = Automation.create(recurringInput(projectID, 60_000), { now: 0 })

      scheduler.reschedule(definition)
      await clock.advance(60_000)
      await waitForStarts(starts, 1)
      expect(starts).toEqual([60_000])

      await clock.advance(60_000)
      expect(starts).toEqual([60_000])

      releaseFirst.resolve()
      await waitForRunStates(definition.id, ["succeeded"])
      await clock.advance(59_999)
      expect(starts).toEqual([60_000])

      await clock.advance(1)
      await waitForRunStates(definition.id, ["succeeded", "succeeded"])
      expect(starts).toEqual([60_000, 180_000])
      scheduler.stop()
    })
  })

  test("keeps the next recurring fire when non-schedule fields change", async () => {
    await withAutomation(async (projectID) => {
      const clock = new FakeClock(0)
      const starts: number[] = []
      const scheduler = AutomationScheduler.make({
        clock,
        executor: async () => {
          starts.push(clock.now())
          return { sessionID: SessionID.descending(), result: "done", cost: 0 }
        },
      })
      const definition = Automation.create(recurringInput(projectID, 60_000), { now: 0 })

      scheduler.reschedule(definition)
      await clock.advance(60_000)
      await waitForRunStates(definition.id, ["succeeded"])

      await clock.advance(59_999)
      const updated = Automation.update(definition.id, { title: "Updated title" }, { now: 119_999 })
      await Automation.publishDefinitionUpdated(updated)
      await clock.advance(1)
      await waitForRunStates(definition.id, ["succeeded", "succeeded"])

      expect(starts).toEqual([60_000, 120_000])
      scheduler.stop()
    })
  })

  test("does not schedule a recurring timer while its scheduled run is active", async () => {
    await withAutomation(async (projectID) => {
      const clock = new FakeClock(0)
      const releaseFirst = deferred<void>()
      const starts: number[] = []
      const scheduler = AutomationScheduler.make({
        clock,
        executor: async () => {
          starts.push(clock.now())
          if (starts.length === 1) await releaseFirst.promise
          return { sessionID: SessionID.descending(), result: "done", cost: 0 }
        },
      })
      const definition = Automation.create(recurringInput(projectID, 30_000), { now: 0 })

      scheduler.reschedule(definition)
      await clock.advance(30_000)
      await waitForStarts(starts, 1)
      expect(starts).toEqual([30_000])

      await clock.advance(10_000)
      const updated = Automation.update(definition.id, { title: "Updated title" }, { now: 40_000 })
      await Automation.publishDefinitionUpdated(updated)

      await clock.advance(30_000)
      expect(Automation.runs({ automationID: definition.id }).items.map((run) => run.state)).toEqual(["scheduled"])

      await clock.advance(20_000)
      releaseFirst.resolve()
      await waitForRunStates(definition.id, ["succeeded"])

      await clock.advance(29_999)
      expect(starts).toEqual([30_000])

      await clock.advance(1)
      await waitForRunStates(definition.id, ["succeeded", "succeeded"])
      expect(starts).toEqual([30_000, 120_000])
      scheduler.stop()
    })
  })

  test("stops scheduling recurring automation after count limit", async () => {
    await withAutomation(async (projectID) => {
      const clock = new FakeClock(0)
      const starts: number[] = []
      const scheduler = AutomationScheduler.make({
        clock,
        executor: async () => {
          starts.push(clock.now())
          return { sessionID: SessionID.descending(), result: "done", cost: 0 }
        },
      })
      const definition = Automation.create(
        recurringInput(projectID, 60_000, { stop: { kind: "count", count: 3 } }),
        { now: 0 },
      )

      scheduler.reschedule(definition)
      await clock.advance(60_000)
      await waitForRunStates(definition.id, ["succeeded"])
      await clock.advance(60_000)
      await waitForRunStates(definition.id, ["succeeded", "succeeded"])
      await clock.advance(60_000)
      await waitForRunStates(definition.id, ["succeeded", "succeeded", "succeeded"])
      await clock.advance(60_000)

      expect(starts).toEqual([60_000, 120_000, 180_000])
      expect(Automation.runs({ automationID: definition.id }).items).toHaveLength(3)
      scheduler.stop()
    })
  })

  test("cancels a pending recurring timer when manual completion reaches count limit", async () => {
    await withAutomation(async (projectID) => {
      const clock = new FakeClock(0)
      const scheduledStarts: number[] = []
      const scheduler = AutomationScheduler.make({
        clock,
        executor: async () => {
          scheduledStarts.push(clock.now())
          return { sessionID: SessionID.descending(), result: "scheduled", cost: 0 }
        },
      })
      const definition = Automation.create(
        recurringInput(projectID, 60_000, { stop: { kind: "count", count: 1 } }),
        { now: 0 },
      )

      scheduler.reschedule(definition)
      await Automation.runNowExecuting(definition.id, {
        now: 30_000,
        executor: async () => ({ sessionID: SessionID.descending(), result: "manual", cost: 0 }),
      })
      await waitForRunStates(definition.id, ["succeeded"])

      await clock.advance(60_000)

      expect(scheduledStarts).toEqual([])
      expect(Automation.runs({ automationID: definition.id }).items).toHaveLength(1)
      scheduler.stop()
    })
  })

  test("stops scheduling recurring automation after count limit above page size", async () => {
    await withAutomation(async (projectID) => {
      const clock = new FakeClock(0)
      const starts: number[] = []
      const scheduler = AutomationScheduler.make({
        clock,
        executor: async () => {
          starts.push(clock.now())
          return { sessionID: SessionID.descending(), result: "done", cost: 0 }
        },
      })
      const definition = Automation.create(
        recurringInput(projectID, 60_000, { stop: { kind: "count", count: 101 } }),
        { now: 0 },
      )

      scheduler.reschedule(definition)
      for (let runCount = 1; runCount <= 101; runCount++) {
        await clock.advance(60_000)
        await waitForStarts(starts, runCount)
        await waitForRunCount(definition.id, runCount)
      }
      await clock.advance(60_000)

      expect(starts).toHaveLength(101)
      expect(allRuns(definition.id)).toHaveLength(101)
      scheduler.stop()
    })
  })

  test("does not schedule recurring condition stops without an evaluator", async () => {
    await withAutomation(async (projectID) => {
      const clock = new FakeClock(0)
      const starts: number[] = []
      const scheduler = AutomationScheduler.make({
        clock,
        executor: async () => {
          starts.push(clock.now())
          return { sessionID: SessionID.descending(), result: "done", cost: 0 }
        },
      })
      const definition = Automation.create(
        recurringInput(projectID, 60_000, { stop: { kind: "condition", condition: "repo is ready" } }),
        { now: 0 },
      )

      scheduler.reschedule(definition)
      await clock.advance(60_000)

      expect(starts).toEqual([])
      expect(Automation.runs({ automationID: definition.id }).items).toHaveLength(0)
      scheduler.stop()
    })
  })

  test("keeps recurring automation scheduled after another automation holds the project writer", async () => {
    await withAutomation(async (projectID) => {
      const clock = new FakeClock(0)
      const releaseWriter = deferred<{ sessionID: SessionID; result: string | null; cost?: number | null }>()
      const writerEntered = deferred<void>()
      const starts: number[] = []
      const blocker = Automation.create(oneshotInput(projectID, 10_000_000), { now: 0 })
      await Automation.runNowExecuting(blocker.id, {
        now: 0,
        executor: async () => {
          writerEntered.resolve()
          return releaseWriter.promise
        },
      })
      await writerEntered.promise
      const scheduler = AutomationScheduler.make({
        clock,
        executor: async () => {
          starts.push(clock.now())
          return { sessionID: SessionID.descending(), result: "scheduled", cost: 0 }
        },
      })
      const definition = Automation.create(recurringInput(projectID, 60_000), { now: 0 })

      scheduler.reschedule(definition)
      await clock.advance(60_000)
      await waitForRunStates(definition.id, ["stopped"])

      releaseWriter.resolve({ sessionID: SessionID.descending(), result: "manual", cost: 0 })
      await waitForRunStates(blocker.id, ["succeeded"])
      await clock.advance(60_000)
      await waitForRunStates(definition.id, ["succeeded", "stopped"])

      expect(starts).toEqual([120_000])
      scheduler.stop()
    })
  })

  test("does not re-anchor recurring schedule after a manual writer conflict stop", async () => {
    await withAutomation(async (projectID) => {
      const clock = new FakeClock(0)
      const releaseBlocker = deferred<{ sessionID: SessionID; result: string | null; cost?: number | null }>()
      const blockerEntered = deferred<void>()
      const scheduler = AutomationScheduler.make({
        clock,
        executor: async () => ({ sessionID: SessionID.descending(), result: "scheduled", cost: 0 }),
      })
      const blocker = Automation.create(oneshotInput(projectID, 10_000_000), { now: 0 })
      const definition = Automation.create(recurringInput(projectID, 60_000), { now: 0 })

      await Automation.runNowExecuting(blocker.id, {
        now: 0,
        executor: async () => {
          blockerEntered.resolve()
          return releaseBlocker.promise
        },
      })
      await blockerEntered.promise
      scheduler.reschedule(definition)

      await clock.advance(30_000)
      await Automation.runNowExecuting(definition.id, {
        now: 30_000,
        executor: async () => ({ sessionID: SessionID.descending(), result: "manual", cost: 0 }),
      })
      await waitForRunStates(definition.id, ["stopped"])

      await clock.advance(30_000)

      const runs = await waitForRunStates(definition.id, ["stopped", "stopped"])
      expect(runs[0].triggeredAt).toBe(60_000)
      releaseBlocker.resolve({ sessionID: SessionID.descending(), result: "blocker done", cost: 0 })
      scheduler.stop()
    })
  })

  test("records a stopped run instead of overlapping an active automation", async () => {
    await withAutomation(async (projectID) => {
      const clock = new FakeClock(0)
      const calls: number[] = []
      const scheduler = AutomationScheduler.make({
        clock,
        executor: async () => {
          calls.push(clock.now())
          return { sessionID: SessionID.descending(), result: "done", cost: 0 }
        },
      })
      const definition = Automation.create(oneshotInput(projectID, 1_000), { now: 0 })
      const active = Automation.runNow(definition.id, { now: 0 })
      Automation.markRunStarted(active, SessionID.descending(), { now: 0 })
      await using _ = await Flock.acquire(`automation-run:${Instance.directory}:${active.id}`)

      scheduler.reschedule(definition)
      await clock.advance(1_000)
      const runs = await waitForRunStates(definition.id, ["stopped", "running"])

      expect(calls).toEqual([])
      expect(runs[0]).toMatchObject({
        state: "stopped",
        stopReason: "previous_run_awaiting_input",
        triggeredAt: 1_000,
        completedAt: 1_000,
      })
      scheduler.stop()
    })
  })

  test("reconciles a stale project writer before firing another automation", async () => {
    await withAutomation(async (projectID) => {
      const clock = new FakeClock(0)
      const calls: number[] = []
      const scheduler = AutomationScheduler.make({
        clock,
        executor: async () => {
          calls.push(clock.now())
          return { sessionID: SessionID.descending(), result: "done", cost: 0 }
        },
      })
      const staleWriter = Automation.create(recurringInput(projectID, 60_000, { title: "Stale writer" }), { now: 0 })
      const stale = Automation.runNow(staleWriter.id, { now: 0 })
      const definition = Automation.create(oneshotInput(projectID, 1_000), { now: 0 })

      scheduler.reschedule(definition)
      await clock.advance(1_000)
      const runs = await waitForRunStates(definition.id, ["succeeded"])

      expect(calls).toEqual([1_000])
      expect(Automation.runs({ automationID: staleWriter.id }).items[0]).toMatchObject({
        id: stale.id,
        state: "stopped",
        stopReason: "expired",
      })
      expect(runs[0]).toMatchObject({ state: "succeeded", triggeredAt: 1_000 })
      scheduler.stop()
    })
  })

  test("does not fire long one-shot timers before the target time", async () => {
    await withAutomation(async (projectID) => {
      const clock = new FakeClock(0)
      const calls: number[] = []
      const scheduler = AutomationScheduler.make({
        clock,
        executor: async () => {
          calls.push(clock.now())
          return { sessionID: SessionID.descending(), result: "done", cost: 0 }
        },
      })
      const fireAt = 3_000_000_000
      const definition = Automation.create(oneshotInput(projectID, fireAt), { now: 0 })

      scheduler.reschedule(definition)
      await clock.advance(2_147_483_647)
      expect(calls).toEqual([])

      await clock.advance(fireAt - 2_147_483_647)
      await waitForRunStates(definition.id, ["succeeded"])

      expect(calls).toEqual([fireAt])
      scheduler.stop()
    })
  })

  test("ignores an aborted stale recurring task after reschedule", async () => {
    await withAutomation(async (projectID) => {
      const clock = new FakeClock(0)
      const runtime = new ManualRuntime()
      const calls: number[] = []
      const scheduler = AutomationScheduler.make({
        clock,
        runtime,
        executor: async () => {
          calls.push(clock.now())
          return { sessionID: SessionID.descending(), result: "done", cost: 0 }
        },
      })
      const definition = Automation.create(recurringInput(projectID, 30_000), { now: 0 })

      scheduler.reschedule(definition)
      await clock.advance(30_000)
      const updated = Automation.update(definition.id, { rhythm: { kind: "interval", everyMs: 40_000 } }, { now: 30_000 })
      scheduler.reschedule(updated)

      runtime.start(0)
      await clock.flush()
      expect(calls).toEqual([])

      runtime.start(1)
      await clock.advance(40_000)
      await waitForRunStates(definition.id, ["succeeded"])
      expect(calls).toEqual([70_000])
      scheduler.stop()
    })
  })

  test("executes schedules after a short overslept timer", async () => {
    await withAutomation(async (projectID) => {
      const clock = new OversleepClock(0, 65_000)
      const calls: number[] = []
      const scheduler = AutomationScheduler.make({
        clock,
        executor: async () => {
          calls.push(clock.now())
          return { sessionID: SessionID.descending(), result: "done", cost: 0 }
        },
      })
      const definition = Automation.create(oneshotInput(projectID, 60_000), { now: 0 })

      scheduler.reschedule(definition)
      await waitForRunStates(definition.id, ["succeeded"])

      expect(calls).toEqual([65_000])
      scheduler.stop()
    })
  })

  test("records a missed one-shot after restart instead of catching up within timer grace", async () => {
    await withAutomation(async (projectID) => {
      const clock = new OversleepClock(90_000, 90_000)
      const calls: number[] = []
      const definition = Automation.create(oneshotInput(projectID, 60_000), { now: 0 })
      const scheduler = AutomationScheduler.make({
        clock,
        executor: async () => {
          calls.push(clock.now())
          return { sessionID: SessionID.descending(), result: "done", cost: 0 }
        },
      })

      const runs = await waitForRunCount(definition.id, 1)

      expect(calls).toEqual([])
      expect(runs[0]).toMatchObject({
        state: "stopped",
        stopReason: "missed_schedule",
        triggeredAt: 60_000,
        completedAt: 90_000,
      })
      scheduler.stop()
    })
  })

  test("records missed schedules instead of catching up after an overslept timer", async () => {
    await withAutomation(async (projectID) => {
      const clock = new OversleepClock(0, 180_001)
      const calls: number[] = []
      const scheduler = AutomationScheduler.make({
        clock,
        executor: async () => {
          calls.push(clock.now())
          return { sessionID: SessionID.descending(), result: "done", cost: 0 }
        },
      })
      const definition = Automation.create(oneshotInput(projectID, 60_000), { now: 0 })

      scheduler.reschedule(definition)
      const runs = await waitForRunCount(definition.id, 1)

      expect(calls).toEqual([])
      expect(runs[0]).toMatchObject({
        state: "stopped",
        stopReason: "missed_schedule",
        triggeredAt: 60_000,
        completedAt: 180_001,
      })
      scheduler.stop()
    })
  })
})
