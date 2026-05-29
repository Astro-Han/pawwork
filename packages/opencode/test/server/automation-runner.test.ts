import { afterEach, describe, expect, test } from "bun:test"
import { Automation } from "../../src/automation"
import { Instance } from "../../src/project/instance"
import { ProjectID } from "../../src/project/schema"
import { SessionID } from "../../src/session/schema"
import { AutomationStepCapError } from "../../src/automation/run-context"
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

function input(projectID: ProjectID): Automation.CreateInput {
  return {
    kind: "recurring",
    title: "Repo brief",
    prompt: "Summarize repo changes.",
    context: "fresh",
    where: { projectID },
    timezone: "Asia/Shanghai",
    rhythm: { kind: "interval", everyMs: 60_000 },
    stop: { kind: "count", count: 3 },
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

  test("keeps one active writer per automation", async () => {
    await withAutomation(async (projectID) => {
      const definition = Automation.create(input(projectID))
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
      if (stopped.state !== "stopped") throw new Error("expected stopped run")
      expect(stopped.stopReason).toBe("previous_run_awaiting_input")
      release()
      const succeeded = await waitForRun(definition.id, "succeeded")
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
    })
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
