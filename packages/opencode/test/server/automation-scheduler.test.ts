import { afterEach, describe, expect, test } from "bun:test"
import { Automation } from "../../src/automation"
import { AutomationScheduler } from "../../src/automation/scheduler"
import { Instance } from "../../src/project/instance"
import { ProjectID } from "../../src/project/schema"
import { SessionID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

class FakeClock implements AutomationScheduler.Clock {
  private timers = new Map<number, { at: number; callback: () => void }>()
  private nextID = 1

  constructor(private current: number) {}

  now() {
    return this.current
  }

  setTimer(delayMs: number, callback: () => void) {
    const id = this.nextID++
    this.timers.set(id, { at: this.current + Math.max(0, delayMs), callback })
    return () => {
      this.timers.delete(id)
    }
  }

  advance(ms: number) {
    const target = this.current + ms
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0]
      if (!next) break
      const [id, timer] = next
      this.timers.delete(id)
      this.current = timer.at
      timer.callback()
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

function recurringInput(projectID: ProjectID, everyMs: number): Automation.CreateInput {
  return {
    kind: "recurring",
    title: "Repo brief",
    prompt: "Summarize repo changes.",
    context: "fresh",
    where: { projectID },
    timezone: "Asia/Shanghai",
    rhythm: { kind: "interval", everyMs },
    stop: { kind: "never" },
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
      clock.advance(999)
      expect(Automation.runs({ automationID: definition.id }).items).toHaveLength(0)

      clock.advance(1)
      const runs = await waitForRunStates(definition.id, ["succeeded"])

      expect(runs).toHaveLength(1)
      expect(runs[0].triggeredAt).toBe(1_000)
      expect(attendance).toEqual(["unattended"])
      clock.advance(10_000)
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

      clock.advance(1_000)
      expect(calls).toEqual([1_000])
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
      clock.advance(1_000)
      await waitForRunStates(definition.id, ["succeeded"])
      scheduler.reschedule(definition)
      clock.advance(0)

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
      clock.advance(1_000)
      await waitForRunStates(definition.id, ["succeeded"])

      const renamed = Automation.update(definition.id, { title: "Updated one-shot" }, { now: 2_000 })
      scheduler.reschedule(renamed)
      const paused = Automation.update(definition.id, { paused: true }, { now: 3_000 })
      scheduler.reschedule(paused)
      const resumed = Automation.update(definition.id, { paused: false }, { now: 4_000 })
      scheduler.reschedule(resumed)
      clock.advance(0)

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
      expect(() => clock.advance(1_000)).not.toThrow()

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
      clock.advance(60_000)
      await waitForRunStates(definition.id, ["stopped", "scheduled"])

      releaseManual.resolve({ sessionID: SessionID.descending(), result: "manual", cost: 0 })
      await waitForRunStates(definition.id, ["stopped", "succeeded"])
      clock.advance(60_000)
      await waitForRunStates(definition.id, ["succeeded", "stopped", "succeeded"])

      expect(schedulerStarts).toEqual([120_000])
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
      clock.advance(60_000)
      expect(starts).toEqual([60_000])

      clock.advance(60_000)
      expect(starts).toEqual([60_000])

      releaseFirst.resolve()
      await waitForRunStates(definition.id, ["succeeded"])
      clock.advance(59_999)
      expect(starts).toEqual([60_000])

      clock.advance(1)
      await waitForRunStates(definition.id, ["succeeded", "succeeded"])
      expect(starts).toEqual([60_000, 180_000])
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
      clock.advance(1_000)
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
      clock.advance(2_147_483_647)
      expect(calls).toEqual([])

      clock.advance(fireAt - 2_147_483_647)
      await waitForRunStates(definition.id, ["succeeded"])

      expect(calls).toEqual([fireAt])
      scheduler.stop()
    })
  })
})
