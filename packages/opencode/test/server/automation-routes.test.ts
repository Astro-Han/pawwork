import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { Log } from "@opencode-ai/core/util/log"
import { Automation, AutomationID } from "../../src/automation"
import { Instance } from "../../src/project/instance"
import { ProjectID } from "../../src/project/schema"
import { ErrorMiddleware } from "../../src/server/middleware"
import { AutomationRoutes } from "../../src/server/instance/automation"
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
      const page = await json(app, `/automation/${created.id}/runs?limit=1&cursor=automation_run_missing`)

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
})
