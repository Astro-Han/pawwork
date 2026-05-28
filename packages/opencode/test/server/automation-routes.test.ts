import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { Log } from "@opencode-ai/core/util/log"
import { Automation, AutomationID } from "../../src/automation"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { ProjectID } from "../../src/project/schema"
import { ErrorMiddleware } from "../../src/server/middleware"
import { AutomationRoutes } from "../../src/server/instance/automation"
import { SessionID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

async function withAutomationApp<T>(fn: (input: { app: Hono; projectID: ProjectID }) => Promise<T>) {
  await using tmp = await tmpdir({ git: true })
  return Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const app = new Hono().route("/automation", AutomationRoutes())
      app.onError(ErrorMiddleware)
      return fn({ app, projectID: Instance.project.id })
    },
  })
}

async function json(app: Hono, input: string, init?: RequestInit) {
  const response = await app.request(input, init)
  return response.json()
}

type RecurringCreateInput = Extract<Automation.CreateInput, { kind: "recurring" }>
type OneshotCreateInput = Extract<Automation.CreateInput, { kind: "oneshot" }>

function recurringInput(projectID: ProjectID, overrides: Partial<RecurringCreateInput> = {}): RecurringCreateInput {
  return {
    kind: "recurring",
    title: "Daily repo brief",
    prompt: "Summarize repo changes.",
    context: "fresh",
    where: { projectID },
    timezone: "Asia/Shanghai",
    rhythm: { kind: "interval", everyMs: 60_000 },
    stop: { kind: "count", count: 3 },
    ...overrides,
  }
}

function oneshotInput(projectID: ProjectID, overrides: Partial<OneshotCreateInput> = {}): OneshotCreateInput {
  return {
    kind: "oneshot",
    title: "One-time repo brief",
    prompt: "Summarize repo changes once.",
    context: "fresh",
    where: { projectID },
    timezone: "Asia/Shanghai",
    fireAt: 1_800_000_000_000,
    ...overrides,
  }
}

function run(overrides: Partial<Automation.Run> = {}) {
  return {
    id: AutomationID.Run.ascending(),
    automationID: AutomationID.Definition.ascending(),
    revision: 1,
    state: "scheduled",
    triggeredAt: 1,
    startedAt: null,
    completedAt: null,
    sessionID: null,
    result: null,
    error: null,
    cost: null,
    ...overrides,
  } satisfies Automation.Run
}

describe("automation routes", () => {
  test("create echoes the resolved definition with revision and normalization warnings", async () => {
    await withAutomationApp(async ({ app, projectID }) => {
      const response = await app.request("/automation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(recurringInput(projectID)),
      })
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body).toMatchObject({
        kind: "recurring",
        title: "Daily repo brief",
        prompt: "Summarize repo changes.",
        revision: 1,
        paused: false,
        context: "fresh",
        where: { projectID },
        timezone: "Asia/Shanghai",
        rhythm: { kind: "interval", everyMs: 60_000 },
        stop: { kind: "count", count: 3 },
        normalizationWarnings: [],
      })
      expect(body.id).toMatch(/^automation_/)
      expect(body.createdAt).toBeNumber()
      expect(body.updatedAt).toBe(body.createdAt)
      expect(body.nextFireAt).toBeNull()
      expect(body.nextFires).toEqual([])
    })
  })

  test("rejects a definition scoped to a different project", async () => {
    await withAutomationApp(async ({ app }) => {
      const response = await app.request("/automation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(recurringInput(ProjectID.zod.parse("other-project"))),
      })
      const body = await response.json()

      expect(response.status).toBe(422)
      expect(body).toEqual({
        error: "invalid_automation",
        details: [{ field: "where.projectID", message: "Automation must target the current project." }],
      })
    })
  })

  test("rejects worktree placement until the PR5 location slice", async () => {
    await withAutomationApp(async ({ app, projectID }) => {
      const response = await app.request("/automation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(recurringInput(projectID, { where: { projectID, worktree: "/repo/.worktrees/run" } })),
      })
      const body = await response.json()

      expect(response.status).toBe(422)
      expect(body.details).toEqual([
        { field: "where.worktree", message: "unsupported_where_worktree" },
      ])
    })
  })

  test("rejects invalid semantic fields with the automation validation error shape", async () => {
    await withAutomationApp(async ({ app, projectID }) => {
      const cases = [
        [
          "invalid cron",
          recurringInput(projectID, { rhythm: { kind: "cron", expression: "not a cron" } }),
          [{ field: "rhythm.expression", message: "invalid_cron_expression" }],
        ],
        [
          "invalid timezone",
          recurringInput(projectID, { timezone: "Mars/Olympus" }),
          [{ field: "timezone", message: "invalid_timezone" }],
        ],
        [
          "oneshot recurring knobs",
          { ...oneshotInput(projectID), rhythm: { kind: "interval", everyMs: 60_000 }, stop: { kind: "never" } },
          [
            { field: "rhythm", message: "unsupported_for_oneshot_automation" },
            { field: "stop", message: "unsupported_for_oneshot_automation" },
          ],
        ],
        [
          "unknown create knob",
          { ...recurringInput(projectID), retryPolicy: { attempts: 3 } },
          [{ field: "retryPolicy", message: "unsupported_automation_field" }],
        ],
      ] as const

      for (const [_name, input, details] of cases) {
        const response = await app.request("/automation", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        })

        expect(response.status).toBe(422)
        expect(await response.json()).toEqual({ error: "invalid_automation", details })
      }
    })
  })

  test("lists definitions and returns a tombstone when deleting", async () => {
    await withAutomationApp(async ({ app, projectID }) => {
      const created = await json(app, "/automation", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(recurringInput(projectID)),
        })

      const listed = await json(app, "/automation")
      expect(listed.items).toHaveLength(1)
      expect(listed.items[0].id).toBe(created.id)

      const deleted = await json(app, `/automation/${created.id}`, { method: "DELETE" })
      expect(deleted).toEqual({ id: created.id, deleted: true, revision: 2 })

      const afterDelete = await json(app, "/automation")
      expect(afterDelete.items).toEqual([])
    })
  })

  test("update accepts a deterministic timestamp", async () => {
    await withAutomationApp(async ({ projectID }) => {
      const definition = Automation.create(recurringInput(projectID), { now: 100 })
      const updated = Automation.update(definition.id, { title: "Updated brief" }, { now: 200 })

      expect(updated).toMatchObject({
        id: definition.id,
        title: "Updated brief",
        revision: 2,
        createdAt: 100,
        updatedAt: 200,
      })
    })
  })

  test("no-op update returns the current definition without revising or publishing", async () => {
    await withAutomationApp(async ({ app, projectID }) => {
      const created = await json(app, "/automation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(recurringInput(projectID)),
      })
      const revisions: number[] = []
      const unsubscribe = Bus.subscribe(Automation.Event.DefinitionUpdated, (event) => {
        revisions.push(event.properties.revision)
      })

      const empty = await json(app, `/automation/${created.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
      const samePaused = await json(app, `/automation/${created.id}/resume`, { method: "POST" })

      await Bun.sleep(10)
      unsubscribe()

      expect(empty.revision).toBe(1)
      expect(empty.updatedAt).toBe(created.updatedAt)
      expect(samePaused.revision).toBe(1)
      expect(samePaused.updatedAt).toBe(created.updatedAt)
      expect(revisions).toEqual([])
    })
  })

  test("pause and resume only revise when paused state changes", async () => {
    await withAutomationApp(async ({ app, projectID }) => {
      const created = await json(app, "/automation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(recurringInput(projectID)),
      })
      const revisions: number[] = []
      const unsubscribe = Bus.subscribe(Automation.Event.DefinitionUpdated, (event) => {
        revisions.push(event.properties.revision)
      })

      const paused = await json(app, `/automation/${created.id}/pause`, { method: "POST" })
      const pausedAgain = await json(app, `/automation/${created.id}/pause`, { method: "POST" })
      const resumed = await json(app, `/automation/${created.id}/resume`, { method: "POST" })
      const resumedAgain = await json(app, `/automation/${created.id}/resume`, { method: "POST" })

      await Bun.sleep(10)
      unsubscribe()

      expect(paused).toMatchObject({ revision: 2, paused: true })
      expect(pausedAgain).toMatchObject({ revision: 2, paused: true })
      expect(resumed).toMatchObject({ revision: 3, paused: false })
      expect(resumedAgain).toMatchObject({ revision: 3, paused: false })
      expect(revisions).toEqual([2, 3])
    })
  })

  test("rejects update fields that do not apply to the existing automation kind", async () => {
    await withAutomationApp(async ({ app, projectID }) => {
      const recurring = await json(app, "/automation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(recurringInput(projectID)),
      })
      const recurringResponse = await app.request(`/automation/${recurring.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fireAt: 1_800_000_000_000 }),
      })
      const recurringBody = await recurringResponse.json()

      expect(recurringResponse.status).toBe(422)
      expect(recurringBody).toEqual({
        error: "invalid_automation",
        details: [{ field: "fireAt", message: "unsupported_for_recurring_automation" }],
      })
      expect(Automation.get(recurring.id).revision).toBe(1)

      const oneshot = await json(app, "/automation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(oneshotInput(projectID)),
      })
      const oneshotResponse = await app.request(`/automation/${oneshot.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rhythm: { kind: "interval", everyMs: 60_000 }, stop: { kind: "never" } }),
      })
      const oneshotBody = await oneshotResponse.json()

      expect(oneshotResponse.status).toBe(422)
      expect(oneshotBody).toEqual({
        error: "invalid_automation",
        details: [
          { field: "rhythm", message: "unsupported_for_oneshot_automation" },
          { field: "stop", message: "unsupported_for_oneshot_automation" },
        ],
      })
      expect(Automation.get(oneshot.id).revision).toBe(1)
    })
  })

  test("rejects update-only validation failures without revising the definition", async () => {
    await withAutomationApp(async ({ app, projectID }) => {
      const recurring = await json(app, "/automation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(recurringInput(projectID)),
      })

      const unknownResponse = await app.request(`/automation/${recurring.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ retryPolicy: { attempts: 3 } }),
      })

      expect(unknownResponse.status).toBe(422)
      expect(await unknownResponse.json()).toEqual({
        error: "invalid_automation",
        details: [{ field: "retryPolicy", message: "unsupported_automation_field" }],
      })
      expect(Automation.get(recurring.id).revision).toBe(1)

      const timezoneResponse = await app.request(`/automation/${recurring.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ timezone: "Mars/Olympus" }),
      })

      expect(timezoneResponse.status).toBe(422)
      expect(await timezoneResponse.json()).toEqual({
        error: "invalid_automation",
        details: [{ field: "timezone", message: "invalid_timezone" }],
      })
      expect(Automation.get(recurring.id).revision).toBe(1)
    })
  })

  test("openapi exposes typed automation validation errors", async () => {
    const { Server } = await import("../../src/server/server")
    const spec = await Server.openapi()
    const paths = spec.paths as Record<string, any>
    const create422 = paths["/automation"].post.responses["422"].content["application/json"].schema
    const update422 = paths["/automation/{automationID}"].put.responses["422"].content["application/json"].schema

    expect(create422).toEqual({ $ref: "#/components/schemas/AutomationValidationError" })
    expect(update422).toEqual({ $ref: "#/components/schemas/AutomationValidationError" })
    expect(spec.components?.schemas).toHaveProperty("AutomationValidationError")
  })

  test("runNow is a contract stub before PR2 execution", async () => {
    await withAutomationApp(async ({ app, projectID }) => {
      const created = await json(app, "/automation", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(recurringInput(projectID)),
        })

      const response = await app.request(`/automation/${created.id}/run`, { method: "POST" })
      const run = await response.json()

      expect(response.status).toBe(200)
      expect(run).toMatchObject({
        automationID: created.id,
        revision: 1,
        state: "scheduled",
      })
      expect(run.id).toMatch(/^automation_run_/)
      expect(run.sessionID).toBeNull()
    })
  })

  test("runs are listed newest first with cursor pagination", async () => {
    await withAutomationApp(async ({ app, projectID }) => {
      const created = await json(app, "/automation", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(recurringInput(projectID)),
        })

      const first = await json(app, `/automation/${created.id}/run`, { method: "POST" })
      const second = await json(app, `/automation/${created.id}/run`, { method: "POST" })

      const page1 = await json(app, `/automation/${created.id}/runs?limit=1`)
      expect(page1.items.map((run: Automation.Run) => run.id)).toEqual([second.id])
      expect(page1.nextCursor).toBe(second.id)

      const page2 = await json(app, `/automation/${created.id}/runs?limit=1&cursor=${encodeURIComponent(page1.nextCursor)}`)
      expect(page2.items.map((run: Automation.Run) => run.id)).toEqual([first.id])
      expect(page2.nextCursor).toBeNull()
    })
  })

  test("runs return an empty page for an unknown cursor", async () => {
    await withAutomationApp(async ({ app, projectID }) => {
      const created = await json(app, "/automation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(recurringInput(projectID)),
      })

      await json(app, `/automation/${created.id}/run`, { method: "POST" })
      const page = await json(
        app,
        `/automation/${created.id}/runs?limit=1&cursor=${encodeURIComponent(AutomationID.Run.ascending())}`,
      )

      expect(page).toEqual({ items: [], nextCursor: null })
    })
  })

  test("schemas freeze terminal reason state mapping", () => {
    expect(() =>
      Automation.Run.parse({
        id: AutomationID.Run.ascending(),
        automationID: AutomationID.Definition.ascending(),
        revision: 1,
        state: "failed",
        triggeredAt: 1,
        startedAt: null,
        completedAt: 2,
        sessionID: null,
        result: null,
        error: null,
        stopReason: "step_cap",
        cost: null,
      }),
    ).not.toThrow()

    expect(() =>
      Automation.Run.parse({
        id: AutomationID.Run.ascending(),
        automationID: AutomationID.Definition.ascending(),
        revision: 1,
        state: "expired",
        triggeredAt: 1,
        startedAt: null,
        completedAt: 2,
        sessionID: null,
        result: null,
        error: null,
        stopReason: "blocker_lost",
        cost: null,
      }),
    ).not.toThrow()

    expect(() =>
      Automation.Run.parse({
        id: AutomationID.Run.ascending(),
        automationID: AutomationID.Definition.ascending(),
        revision: 1,
        state: "expired",
        triggeredAt: 1,
        startedAt: null,
        completedAt: 2,
        sessionID: null,
        result: null,
        error: null,
        stopReason: "step_cap",
        cost: null,
      }),
    ).toThrow()
  })

  test("schemas freeze run state consistency", () => {
    const blocker = { kind: "permission" as const, sessionID: SessionID.descending() }
    const error = { code: "execution_failed" as const, message: "failed" }

    expect(() => Automation.Run.parse(run({ state: "scheduled" }))).not.toThrow()
    expect(() => Automation.Run.parse(run({ state: "running", startedAt: 1 }))).not.toThrow()
    expect(() => Automation.Run.parse(run({ state: "awaiting_input", startedAt: 1, blocker }))).not.toThrow()
    expect(() => Automation.Run.parse(run({ state: "succeeded", startedAt: 1, completedAt: 2, result: "done" }))).not.toThrow()
    expect(() => Automation.Run.parse(run({ state: "failed", startedAt: 1, completedAt: 2, error }))).not.toThrow()
    expect(() =>
      Automation.Run.parse(
        run({ state: "skipped", completedAt: 2, skipReason: "previous_run_awaiting_input" }),
      ),
    ).not.toThrow()
    expect(() =>
      Automation.Run.parse(run({ state: "expired", completedAt: 2, stopReason: "blocker_lost" })),
    ).not.toThrow()

    expect(() => Automation.Run.parse(run({ state: "awaiting_input", startedAt: 1 }))).toThrow()
    expect(() => Automation.Run.parse(run({ state: "running", startedAt: 1, blocker }))).toThrow()
    expect(() => Automation.Run.parse(run({ state: "skipped", completedAt: 2 }))).toThrow()
    expect(() => Automation.Run.parse(run({ state: "failed", startedAt: 1, completedAt: null, error }))).toThrow()
    expect(() => Automation.Run.parse(run({ state: "failed", startedAt: 1, completedAt: 2 }))).toThrow()
  })
})
