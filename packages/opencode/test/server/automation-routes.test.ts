import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { Log } from "@opencode-ai/core/util/log"
import { Automation, AutomationID } from "../../src/automation"
import { Instance } from "../../src/project/instance"
import { ErrorMiddleware } from "../../src/server/middleware"
import { AutomationRoutes } from "../../src/server/instance/automation"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

async function withAutomationApp<T>(fn: (input: { app: Hono; projectID: string }) => Promise<T>) {
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

function recurringInput(projectID: string, overrides: Partial<Automation.CreateInput> = {}): Automation.CreateInput {
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
        body: JSON.stringify(recurringInput("other-project")),
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
      const created = await app
        .request("/automation", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(recurringInput(projectID)),
        })
        .then((response) => response.json())

      const listed = await app.request("/automation").then((response) => response.json())
      expect(listed.items).toHaveLength(1)
      expect(listed.items[0].id).toBe(created.id)

      const deleted = await app.request(`/automation/${created.id}`, { method: "DELETE" }).then((response) => response.json())
      expect(deleted).toEqual({ id: created.id, deleted: true, revision: 2 })

      const afterDelete = await app.request("/automation").then((response) => response.json())
      expect(afterDelete.items).toEqual([])
    })
  })

  test("runNow is a contract stub before PR2 execution", async () => {
    await withAutomationApp(async ({ app, projectID }) => {
      const created = await app
        .request("/automation", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(recurringInput(projectID)),
        })
        .then((response) => response.json())

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
      const created = await app
        .request("/automation", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(recurringInput(projectID)),
        })
        .then((response) => response.json())

      const first = await app.request(`/automation/${created.id}/run`, { method: "POST" }).then((response) => response.json())
      const second = await app.request(`/automation/${created.id}/run`, { method: "POST" }).then((response) => response.json())

      const page1 = await app.request(`/automation/${created.id}/runs?limit=1`).then((response) => response.json())
      expect(page1.items.map((run: Automation.Run) => run.id)).toEqual([second.id])
      expect(page1.nextCursor).toBe(second.id)

      const page2 = await app
        .request(`/automation/${created.id}/runs?limit=1&cursor=${encodeURIComponent(page1.nextCursor)}`)
        .then((response) => response.json())
      expect(page2.items.map((run: Automation.Run) => run.id)).toEqual([first.id])
      expect(page2.nextCursor).toBeNull()
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
