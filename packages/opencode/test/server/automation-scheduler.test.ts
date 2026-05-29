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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function waitForRunStates(automationID: string, states: Automation.Run["state"][]) {
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    const items = Automation.runs({ automationID }).items
    if (items.length >= states.length && states.every((state, index) => items[index]?.state === state)) return items
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for automation run states: ${states.join(", ")}`)
}

async function waitForRunCount(automationID: string, count: number) {
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    const items = Automation.runs({ automationID, limit: 100 }).items
    if (items.length >= count) return items
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for automation run count: ${count}`)
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
      Automation.remove(definition.id)
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
      Automation.runNowExecuting(definition.id, {
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
      expect(runSignal?.aborted).toBe(false)

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
      expect(runSignal?.aborted).toBe(false)

      await Instance.dispose()

      expect(runSignal?.aborted).toBe(true)
      releaseRun.resolve({ sessionID: SessionID.descending(), result: "done", cost: 0 })
      releaseUnrelatedRun()
      await Bun.sleep(0)
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
      Automation.runNowExecuting(definition.id, {
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
      Automation.runNowExecuting(definition.id, {
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

  test("stops scheduling recurring automation after count limit above default page size", async () => {
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
        recurringInput(projectID, 60_000, { stop: { kind: "count", count: 51 } }),
        { now: 0 },
      )

      scheduler.reschedule(definition)
      for (let runCount = 1; runCount <= 51; runCount++) {
        await clock.advance(60_000)
        await waitForRunCount(definition.id, runCount)
      }
      await clock.advance(60_000)

      expect(starts).toHaveLength(51)
      expect(Automation.runs({ automationID: definition.id, limit: 100 }).items).toHaveLength(51)
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
      const starts: number[] = []
      const blocker = Automation.create(oneshotInput(projectID, 10_000_000), { now: 0 })
      Automation.runNowExecuting(blocker.id, {
        now: 0,
        executor: async () => releaseWriter.promise,
      })
      await waitForRunStates(blocker.id, ["scheduled"])
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
})
