import { afterEach, describe, expect, test } from "bun:test"
import { Effect, ManagedRuntime, Schema } from "effect"
import { Automation } from "../../src/automation"
import { AutomationScheduler } from "../../src/automation/scheduler"
import { Instance } from "../../src/project/instance"
import { ProjectID } from "../../src/project/schema"
import { MessageID, SessionID } from "../../src/session/schema"
import { AutomateManageParameters, createAutomateManageDefinition } from "../../src/tool/automate-manage"
import { Flock } from "../../src/util/flock"
import { tmpdir } from "../fixture/fixture"
import { fakeAutomationProvider } from "../fake/provider"

const { providerID, modelID } = fakeAutomationProvider()
const runtime = ManagedRuntime.make(Automation.defaultLayer)
const automation = await runtime.runPromise(Effect.gen(function* () {
  return yield* Automation.Service
}))

function recurring(projectID: ProjectID, title: string): Automation.CreateInput {
  return {
    kind: "recurring",
    title,
    prompt: `Run ${title}.`,
    context: "fresh",
    where: { projectID },
    timezone: "UTC",
    model: { providerID, modelID },
    rhythm: { kind: "cron", expression: "0 9 * * *" },
    stop: { kind: "never" },
  }
}

function installScheduler(cancelled: string[] = [], settled: string[] = []) {
  AutomationScheduler.install({
    stop: () => undefined,
    settleOwner: async () => { settled.push("settled") },
    reschedule: () => undefined,
    cancel: (automationID) => cancelled.push(automationID),
    computeNextFireAt: () => null,
  })
}

function tool() {
  return createAutomateManageDefinition(automation)
}

function toolContext(asks: unknown[] = []) {
  return {
    sessionID: SessionID.descending(),
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    metadata: () => Effect.void,
    ask: (input: unknown) => Effect.sync(() => { asks.push(input) }),
  }
}

afterEach(async () => {
  AutomationScheduler.stopProcess({ stopRuns: false })
  await Instance.disposeAll()
})

describe("automate_manage tool", () => {
  test("schema keeps the model-facing management surface flat and exact-id based", () => {
    const decoded = Schema.decodeUnknownSync(AutomateManageParameters)({
      action: "pause",
      id: "aut_123",
      paused: true,
      where: { projectID: "spoofed" },
    })

    expect(decoded).toEqual({ action: "pause", id: "aut_123" })
  })

  test("lists current-scope automations with ids and schedules", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        installScheduler()
        const created = Automation.create(recurring(Instance.project.id, "Daily repo brief"), { now: 100 })

        const result = await Effect.runPromise(tool().execute({ action: "list" }, toolContext()))
        const output = JSON.parse(result.output)

        expect(result.title).toBe("Automations")
        expect(output.items).toEqual([
          expect.objectContaining({
            id: created.id,
            title: "Daily repo brief",
            paused: false,
            schedule: "0 9 * * *",
            timezone: "UTC",
          }),
        ])
      },
    })
  })

  test("list reads definitions without settling the scheduler owner", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const settled: string[] = []
        installScheduler([], settled)
        Automation.create(recurring(Instance.project.id, "Daily repo brief"), { now: 100 })

        await Effect.runPromise(tool().execute({ action: "list" }, toolContext()))

        expect(settled).toEqual([])
      },
    })
  })

  test("pause and resume update by exact id without asking for confirmation", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        installScheduler()
        const asks: unknown[] = []
        const created = Automation.create(recurring(Instance.project.id, "Daily repo brief"), { now: 100 })

        const paused = await Effect.runPromise(tool().execute({ action: "pause", id: created.id }, toolContext(asks)))
        expect(paused.title).toBe("Automation paused")
        expect(paused.metadata.automationDefinition).toMatchObject({ id: created.id, paused: true, revision: 2 })
        expect(Automation.get(created.id).paused).toBe(true)

        const resumed = await Effect.runPromise(tool().execute({ action: "resume", id: created.id }, toolContext(asks)))
        expect(resumed.title).toBe("Automation resumed")
        expect(resumed.metadata.automationDefinition).toMatchObject({ id: created.id, paused: false, revision: 3 })
        expect(Automation.get(created.id).paused).toBe(false)
        expect(asks).toEqual([])
      },
    })
  })

  test("delete asks once, cancels the scheduler, and removes the automation", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cancelled: string[] = []
        const asks: unknown[] = []
        installScheduler(cancelled)
        const created = Automation.create(recurring(Instance.project.id, "Daily repo brief"), { now: 100 })

        const result = await Effect.runPromise(tool().execute({ action: "delete", id: created.id }, toolContext(asks)))

        expect(result.title).toBe("Automation deleted")
        expect(result.metadata.automationTombstone).toEqual({ id: created.id, deleted: true, revision: 2 })
        expect(JSON.parse(result.output)).toEqual({ id: created.id, deleted: true, revision: 2 })
        expect(cancelled).toEqual([created.id])
        expect(asks).toEqual([
          {
            permission: "automate_manage",
            patterns: [created.id],
            always: [],
            metadata: { action: "delete", id: created.id, title: "Daily repo brief" },
          },
        ])
        expect(Automation.list()).toEqual([])
      },
    })
  })

  test("non-list actions require an exact automation id", async () => {
    installScheduler()
    await expect(Effect.runPromise(tool().execute({ action: "pause" }, toolContext()))).rejects.toThrow(
      'automate_manage action "pause" requires an exact automation id.',
    )
  })

  test("pause reports stale automation ids as a readable relist error", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        installScheduler()

        await expect(
          Effect.runPromise(tool().execute({ action: "pause", id: "aut_missing" }, toolContext())),
        ).rejects.toThrow("Automation not found: aut_missing. Run automate_manage list to get a current id.")
      },
    })
  })

  test("delete rejects stale automation ids before asking or removing anything", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        installScheduler()
        const asks: unknown[] = []
        const created = Automation.create(recurring(Instance.project.id, "Daily repo brief"), { now: 100 })

        await expect(
          Effect.runPromise(tool().execute({ action: "delete", id: "aut_missing" }, toolContext(asks))),
        ).rejects.toThrow("Automation not found: aut_missing. Run automate_manage list to get a current id.")

        expect(asks).toEqual([])
        expect(Automation.list().map((definition) => definition.id)).toEqual([created.id])
      },
    })
  })

  test("delete preserves the automation when a live active run is still running", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        installScheduler()
        const created = Automation.create(recurring(Instance.project.id, "Daily repo brief"), { now: 100 })
        const active = Automation.runNow(created.id, { now: 200 })
        await using _lease = await Flock.acquire(`automation-run:${Instance.directory}:${active.id}`)

        await expect(
          Effect.runPromise(tool().execute({ action: "delete", id: created.id }, toolContext())),
        ).rejects.toThrow(`Cannot delete automation ${created.id}: active_run_still_running (${active.id})`)

        expect(Automation.get(created.id).id).toBe(created.id)
      },
    })
  })

  test("delete stops before removal when the confirmation is denied", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        installScheduler()
        const created = Automation.create(recurring(Instance.project.id, "Daily repo brief"), { now: 100 })
        const ctx = { ...toolContext(), ask: () => Effect.die(new Error("denied")) }

        await expect(Effect.runPromise(tool().execute({ action: "delete", id: created.id }, ctx))).rejects.toThrow(
          "denied",
        )

        expect(Automation.get(created.id).id).toBe(created.id)
      },
    })
  })
})
