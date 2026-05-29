import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Automation } from "../../src/automation"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { ProjectID } from "../../src/project/schema"
import { SessionID } from "../../src/session/schema"
import { AutomationRunContext, AutomationStepCapError } from "../../src/automation/run-context"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

async function withAutomation<T>(fn: (projectID: ProjectID) => Promise<T>) {
  await using tmp = await tmpdir({ git: true })
  return Instance.provide({
    directory: tmp.path,
    fn: () => fn(Instance.project.id),
  })
}

function input(projectID: ProjectID, overrides: Partial<Extract<Automation.CreateInput, { kind: "recurring" }>> = {}): Automation.CreateInput {
  return {
    kind: "recurring",
    title: "Repo brief",
    prompt: "Summarize repo changes.",
    context: "fresh",
    where: { projectID },
    timezone: "Asia/Shanghai",
    rhythm: { kind: "interval", everyMs: 60_000 },
    stop: { kind: "count", count: 3 },
    ...overrides,
  }
}

async function waitForRun(automationID: string, state: Automation.Run["state"]) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const run = Automation.runs({ automationID }).items.find((item) => item.state === state)
    if (run?.state === state) return run
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${state}`)
}

describe("automation runNow execution", () => {
  test("executes a run and records the terminal result", async () => {
    await withAutomation(async (projectID) => {
      const definition = Automation.create(input(projectID))
      const sessionID = SessionID.descending()

      const initial = Automation.runNowExecuting(definition.id, {
        executor: async () => ({ sessionID, result: "done", cost: 0 }),
      })
      expect(initial.state).toBe("scheduled")

      const completed = await waitForRun(definition.id, "succeeded")
      expect(completed).toMatchObject({
        state: "succeeded",
        sessionID,
        result: "done",
        error: null,
      })
      expect(completed.revision).toBeGreaterThan(initial.revision)
    })
  })

  test("keeps one active writer per project", async () => {
    await withAutomation(async (projectID) => {
      const first = Automation.create(input(projectID, { title: "First automation" }))
      const second = Automation.create(input(projectID, { title: "Second automation" }))
      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      let entered = 0

      Automation.runNowExecuting(first.id, {
        executor: async () => {
          entered++
          await held
          return { sessionID: SessionID.descending(), result: "first", cost: 0 }
        },
      })
      Automation.runNowExecuting(second.id, {
        executor: async () => {
          entered++
          return { sessionID: SessionID.descending(), result: "second", cost: 0 }
        },
      })

      const stopped = await waitForRun(second.id, "stopped")
      if (stopped.state !== "stopped") throw new Error("expected stopped run")
      expect(stopped.stopReason).toBe("previous_run_awaiting_input")
      expect(entered).toBe(1)
      release()
      const succeeded = await waitForRun(first.id, "succeeded")
      expect(succeeded.result).toBe("first")
    })
  })

  test("records and clears blocker state on the run ledger", async () => {
    await withAutomation(async (projectID) => {
      const definition = Automation.create(input(projectID))
      const run = Automation.runNow(definition.id)
      const started = Automation.markRunStarted(run, SessionID.descending(), { now: run.triggeredAt })
      const blocked = Automation.markRunBlocked(started, { kind: "question", callID: "call_1" })
      const cleared = Automation.clearRunBlocker(blocked)

      expect(blocked).toMatchObject({
        state: "awaiting_input",
        blocker: { kind: "question", callID: "call_1" },
      })
      expect(cleared.state).toBe("running")
      expect(cleared).not.toHaveProperty("blocker")
      expect(Automation.clearRunBlocker(cleared)).toBe(cleared)
    })
  })

  test("drops state-specific fields when a run transitions out of that state", async () => {
    await withAutomation(async (projectID) => {
      const definition = Automation.create(input(projectID))

      Automation.runNowExecuting(definition.id, {
        executor: async ({ run }) => {
          const started = Automation.markRunStarted(run, SessionID.descending(), { now: run.triggeredAt })
          Automation.markRunBlocked(started, { kind: "question", callID: "call_1" })
          throw new Error("boom")
        },
      })

      const failed = await waitForRun(definition.id, "failed")
      expect(failed).not.toHaveProperty("blocker")

      let release!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      Automation.runNowExecuting(definition.id, {
        executor: async () => {
          await held
          return { sessionID: SessionID.descending(), result: "first", cost: 0 }
        },
      })
      Automation.runNowExecuting(definition.id, {
        executor: async () => ({ sessionID: SessionID.descending(), result: "second", cost: 0 }),
      })
      const stopped = await waitForRun(definition.id, "stopped")
      if (stopped.completedAt === null) throw new Error("expected stopped run to have completedAt")
      const restarted = Automation.markRunStarted(stopped, SessionID.descending(), { now: stopped.completedAt })
      expect(restarted).not.toHaveProperty("stopReason")
      release()
    })
  })

  test("publishes continue-session definition updates from the latest definition", async () => {
    await withAutomation(async (projectID) => {
      const definition = Automation.create(input(projectID, { context: "continue" }))
      const sessionID = SessionID.descending()
      const definitionEvents: Automation.Definition[] = []
      const unsubscribe = Bus.subscribe(Automation.Event.DefinitionUpdated, (event) => {
        definitionEvents.push(event.properties)
      })

      Automation.runNowExecuting(definition.id, {
        executor: async () => {
          Automation.update(definition.id, { title: "Updated repo brief", prompt: "Use the latest prompt." })
          return { sessionID, result: "done", cost: 0 }
        },
      })

      await waitForRun(definition.id, "succeeded")
      unsubscribe()
      const updated = Automation.get(definition.id)
      expect(updated.title).toBe("Updated repo brief")
      expect(updated.prompt).toBe("Use the latest prompt.")
      expect(updated.automationSessionID).toBe(sessionID)
      expect(definitionEvents.at(-1)).toMatchObject({
        id: definition.id,
        title: "Updated repo brief",
        prompt: "Use the latest prompt.",
        automationSessionID: sessionID,
      })
    })
  })

  test("does not revive a continue automation deleted during execution", async () => {
    await withAutomation(async (projectID) => {
      const definition = Automation.create(input(projectID, { context: "continue" }))
      const definitionEvents: Automation.Definition[] = []
      const unsubscribeDefinition = Bus.subscribe(Automation.Event.DefinitionUpdated, (event) => {
        definitionEvents.push(event.properties)
      })
      let removed!: ReturnType<typeof Automation.remove>

      Automation.runNowExecuting(definition.id, {
        executor: async () => {
          removed = Automation.remove(definition.id)
          return { sessionID: SessionID.descending(), result: "done", cost: 0 }
        },
      })

      await Bun.sleep(20)
      unsubscribeDefinition()
      expect(removed.stoppedRun).toMatchObject({ state: "stopped", stopReason: "cancelled" })
      expect(() => Automation.get(definition.id)).toThrow()
      expect(definitionEvents).toHaveLength(0)
    })
  })

  test("aborts an active run when its automation is deleted", async () => {
    await withAutomation(async (projectID) => {
      const definition = Automation.create(input(projectID))
      const sessionID = SessionID.descending()
      let sawAbort = false
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()

      Automation.runNowExecuting(definition.id, {
        executor: async ({ run, signal }) => {
          Automation.markRunStarted(run, sessionID, { now: run.triggeredAt })
          signal.addEventListener("abort", () => {
            sawAbort = true
            release.resolve()
          })
          started.resolve()
          await release.promise
          return { sessionID, result: "should not succeed", cost: 0 }
        },
      })

      await started.promise
      const removed = Automation.remove(definition.id)

      expect(sawAbort).toBe(true)
      expect(removed.stoppedRun).toMatchObject({
        state: "stopped",
        sessionID,
        stopReason: "cancelled",
      })
      await Bun.sleep(20)
      expect(removed.stoppedRun).not.toMatchObject({ state: "succeeded" })
    })
  })

  test("unattended context construction overrides any existing attendance tag", async () => {
    const handlers = {
      stepCap: 50,
      block: () => Effect.void,
      clear: () => Effect.void,
    }
    const attended = AutomationRunContext.attended(handlers)
    const unattended = AutomationRunContext.unattended(attended)

    expect(attended.attendance).toBe("attended")
    expect(unattended.attendance).toBe("unattended")
  })

  test("records hard step-cap failures with the frozen stop code", async () => {
    await withAutomation(async (projectID) => {
      const definition = Automation.create(input(projectID))

      Automation.runNowExecuting(definition.id, {
        executor: async ({ run }) => {
          Automation.markRunStarted(run, SessionID.descending(), { now: run.triggeredAt })
          throw new AutomationStepCapError(50)
        },
      })

      const failed = await waitForRun(definition.id, "failed")
      expect(failed.error).toEqual({
        code: "step_cap",
        message: "Automation run exceeded the hard step cap (50).",
      })
    })
  })
})
