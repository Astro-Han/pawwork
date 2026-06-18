import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { Log } from "@opencode-ai/core/util/log"
import { Automation, AutomationID } from "../../src/automation"
import { AutomationRunTable } from "../../src/automation/automation.sql"
import { AutomationScheduler } from "../../src/automation/scheduler"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { ProjectID } from "../../src/project/schema"
import { ErrorMiddleware } from "../../src/server/middleware"
import { AutomationRoutes } from "../../src/server/instance/automation"
import { PermissionID } from "../../src/permission/schema"
import { SessionID } from "../../src/session/schema"
import { Database, eq } from "../../src/storage/db"
import { Flock } from "../../src/util/flock"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

const previousSkipAutomationModelValidation = process.env.OPENCODE_SKIP_AUTOMATION_MODEL_VALIDATION

beforeAll(() => {
  process.env.OPENCODE_SKIP_AUTOMATION_MODEL_VALIDATION = "1"
})

afterAll(() => {
  if (previousSkipAutomationModelValidation === undefined) delete process.env.OPENCODE_SKIP_AUTOMATION_MODEL_VALIDATION
  else process.env.OPENCODE_SKIP_AUTOMATION_MODEL_VALIDATION = previousSkipAutomationModelValidation
})

afterEach(async () => {
  AutomationScheduler.stopProcess({ stopRuns: false })
  await Instance.disposeAll()
})

async function withAutomationApp<T>(
  fn: (input: { app: Hono; projectID: ProjectID }) => Promise<T>,
  options: { git?: boolean } = { git: true },
) {
  await using tmp = await tmpdir({ git: options.git ?? true })
  return await Instance.provide({
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

async function waitForRunState(automationID: string, state: Automation.Run["state"]) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const run = Automation.runs({ automationID }).items[0]
    if (run?.state === state) return run
    await Bun.sleep(5)
  }
  throw new Error(`Timed out waiting for automation run state: ${state}`)
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

type RecurringCreateInput = Extract<Automation.CreateInput, { kind: "recurring" }>
type OneshotCreateInput = Extract<Automation.CreateInput, { kind: "oneshot" }>

const fixtureModel = Automation.Model.parse({ providerID: "anthropic", modelID: "claude-sonnet-4-6" })

function recurringInput(projectID: ProjectID, overrides: Partial<RecurringCreateInput> = {}): RecurringCreateInput {
  return {
    kind: "recurring",
    title: "Daily repo brief",
    prompt: "Summarize repo changes.",
    context: "fresh",
    where: { projectID },
    timezone: "Asia/Shanghai",
    model: fixtureModel,
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
    model: fixtureModel,
    fireAt: 1_800_000_000_000,
    ...overrides,
  }
}

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: AutomationID.Run.ascending(),
    automationID: AutomationID.Definition.ascending(),
    revision: 1,
    definitionRevision: 1,
    state: "scheduled",
    triggeredAt: 1,
    startedAt: null,
    completedAt: null,
    sessionID: null,
    result: null,
    error: null,
    cost: null,
    ...overrides,
  }
}

describe("automation route 422 wiring with provider validation enabled", () => {
  // These tests deliberately bypass the suite-wide skip flag to exercise the
  // real modelValidationDetails -> AppRuntime path that production hits.
  let restoreBypass: string | undefined
  const enableValidation = () => {
    restoreBypass = process.env.OPENCODE_SKIP_AUTOMATION_MODEL_VALIDATION
    delete process.env.OPENCODE_SKIP_AUTOMATION_MODEL_VALIDATION
  }
  const restoreBypassEnv = () => {
    if (restoreBypass === undefined) delete process.env.OPENCODE_SKIP_AUTOMATION_MODEL_VALIDATION
    else process.env.OPENCODE_SKIP_AUTOMATION_MODEL_VALIDATION = restoreBypass
  }

  test("create rejects with 422 invalid_automation details when provider lookup fails", async () => {
    await withAutomationApp(async ({ app, projectID }) => {
      enableValidation()
      try {
        const response = await app.request("/automation", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            recurringInput(projectID, {
              model: Automation.Model.parse({ providerID: "nonexistent", modelID: "missing-model" }),
            }),
          ),
        })
        expect(response.status).toBe(422)
        const body = await response.json()
        expect(body.error).toBe("invalid_automation")
        expect(body.details).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ field: "model" }),
          ]),
        )
        expect(["model_not_found", "model_lookup_failed"]).toContain(body.details[0].message)
      } finally {
        restoreBypassEnv()
      }
    })
  })

  test("update rejects with 422 invalid_automation details when model patch fails provider lookup", async () => {
    await withAutomationApp(async ({ app, projectID }) => {
      const created = await json(app, "/automation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(recurringInput(projectID)),
      })
      enableValidation()
      try {
        const response = await app.request(`/automation/${created.id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: { providerID: "nonexistent", modelID: "missing-model" } }),
        })
        expect(response.status).toBe(422)
        const body = await response.json()
        expect(body.error).toBe("invalid_automation")
        expect(body.details[0].field).toBe("model")
        expect(["model_not_found", "model_lookup_failed"]).toContain(body.details[0].message)
      } finally {
        restoreBypassEnv()
      }
    })
  })
})

describe("automation routes", () => {
  test("reloads definitions and runs from durable storage after instance restart", async () => {
    await using tmp = await tmpdir({ git: true })
    let automationID: string | undefined

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const definition = Automation.create(recurringInput(Instance.project.id), { now: 100 })
        const run = Automation.runNow(definition.id, { now: 200 })
        automationID = definition.id

        expect(run.automationID).toBe(definition.id)
      },
    })

    await Instance.disposeAll()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        if (!automationID) throw new Error("expected automationID")
        expect(Automation.list().map((item) => item.id)).toEqual([automationID])
        expect(Automation.runs({ automationID }).items.map((item) => item.triggeredAt)).toEqual([200])
      },
    })
  })

  test("reconciles persisted active runs with stopped reasons after restart", async () => {
    await using tmp = await tmpdir({ git: true })
    let automationID: string | undefined

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const definition = Automation.create(recurringInput(Instance.project.id), { now: 100 })
        const scheduled = Automation.runNow(definition.id, { now: 200 })
        const running = Automation.markRunStarted(scheduled, SessionID.descending(), { now: 300 })
        Automation.markRunBlocked(running, { kind: "question", callID: "call_1" })
        automationID = definition.id
      },
    })

    await Instance.disposeAll()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        if (!automationID) throw new Error("expected automationID")
        const reconciled = await Automation.reconcileInterruptedRuns({ now: 400 })
        expect(reconciled).toHaveLength(1)
        expect(reconciled[0]).toMatchObject({ state: "stopped", stopReason: "blocker_lost", completedAt: 400 })
        expect(Automation.runs({ automationID }).items[0]).toMatchObject({
          state: "stopped",
          stopReason: "blocker_lost",
          completedAt: 400,
        })
      },
    })
  })

  test("does not reconcile a persisted active run while another process holds its run lease", async () => {
    await withAutomationApp(async ({ projectID }) => {
      const definition = Automation.create(recurringInput(projectID), { now: 100 })
      const active = Automation.runNow(definition.id, { now: 200 })
      await using _ = await Flock.acquire(`automation-run:${Instance.directory}:${active.id}`)

      const reconciled = await Automation.reconcileInterruptedRuns({ now: 300 })

      expect(reconciled).toEqual([])
      expect(Automation.runs({ automationID: definition.id }).items[0]).toMatchObject({
        id: active.id,
        state: "scheduled",
      })

      const blockedDefinition = Automation.create(recurringInput(projectID, { title: "Blocked repo brief" }), { now: 100 })
      let started = false
      await Automation.runNowExecuting(blockedDefinition.id, {
        now: 400,
        executor: async () => {
          started = true
          return { sessionID: SessionID.descending(), result: "done", cost: 0 }
        },
      })
      const blocked = await waitForRunState(blockedDefinition.id, "stopped")
      expect(started).toBe(false)
      expect(blocked).toMatchObject({ state: "stopped", stopReason: "previous_run_awaiting_input" })
    })
  })

  test("does not expose an executing run to reconcile before its run lease is held", async () => {
    await withAutomationApp(async ({ projectID }) => {
      const release = deferred<{ sessionID: SessionID; result: string | null; cost?: number | null }>()
      const definition = Automation.create(recurringInput(projectID), { now: 100 })

      const pending = Automation.runNowExecuting(definition.id, {
        now: 200,
        executor: async () => release.promise,
      })

      expect(Automation.runs({ automationID: definition.id }).items).toEqual([])
      expect(await Automation.reconcileInterruptedRuns({ now: 300 })).toEqual([])

      const initial = await pending
      expect(Automation.runs({ automationID: definition.id }).items[0]).toMatchObject({
        id: initial.id,
        state: "scheduled",
      })

      release.resolve({ sessionID: SessionID.descending(), result: "done", cost: 0 })
      await waitForRunState(definition.id, "succeeded")
    })
  })

  test("does not reconcile a run that is active in the current process", async () => {
    await withAutomationApp(async ({ projectID }) => {
      const release = deferred<void>()
      const entered = deferred<void>()
      const definition = Automation.create(recurringInput(projectID), { now: 100 })
      const initial = await Automation.runNowExecuting(definition.id, {
        now: 200,
        executor: async () => {
          entered.resolve()
          await release.promise
          return { sessionID: SessionID.descending(), result: "done", cost: 0 }
        },
      })

      await entered.promise
      await expect(Automation.reconcileInterruptedRuns({ now: 300 })).resolves.toEqual([])
      expect(Automation.runs({ automationID: definition.id }).items[0]).toMatchObject({
        id: initial.id,
        state: "scheduled",
      })

      release.resolve()
      const run = await waitForRunState(definition.id, "succeeded")
      expect(run).toMatchObject({ id: initial.id, state: "succeeded" })
    })
  })

  test("list route waits for scheduler owner settle before returning persisted definitions", async () => {
    await withAutomationApp(async ({ app, projectID }) => {
      const gate = deferred<void>()
      let settled = false
      let responseSettled = false
      AutomationScheduler.install({
        stop: () => undefined,
        settleOwner: async () => {
          settled = true
          await gate.promise
        },
        reschedule: () => undefined,
        cancel: () => undefined,
        computeNextFireAt: () => null,
      })
      const definition = Automation.create(recurringInput(projectID), { now: 100 })

      const responsePromise = json(app, "/automation").then((response) => {
        responseSettled = true
        return response
      })
      await Bun.sleep(0)

      expect(settled).toBe(true)
      expect(responseSettled).toBe(false)
      gate.resolve()
      const response = await responsePromise
      expect(response.items.map((item: Automation.Definition) => item.id)).toEqual([definition.id])
    })
  })

  test("runNow route reconciles stale persisted active runs before queuing a new run", async () => {
    await withAutomationApp(async ({ app, projectID }) => {
      const gate = deferred<void>()
      let settled = false
      let responseSettled = false
      AutomationScheduler.install({
        stop: () => undefined,
        settleOwner: async () => {
          settled = true
          await gate.promise
          for (const run of await Automation.reconcileInterruptedRuns({ now: 300 })) await Automation.publishRunUpdated(run)
        },
        reschedule: () => undefined,
        cancel: () => undefined,
        computeNextFireAt: () => null,
      })
      const definition = Automation.create(recurringInput(projectID), { now: 100 })
      const stale = Automation.runNow(definition.id, { now: 200 })

      const responsePromise = json(app, `/automation/${definition.id}/run`, { method: "POST" }).then((response) => {
        responseSettled = true
        return response
      })
      await Bun.sleep(0)

      expect(settled).toBe(true)
      expect(responseSettled).toBe(false)
      gate.resolve()
      const response = await responsePromise
      const runs = Automation.runs({ automationID: definition.id }).items

      expect(response).toMatchObject({ automationID: definition.id, state: "scheduled" })
      expect(response.id).not.toBe(stale.id)
      expect(runs.find((run) => run.id === stale.id)).toMatchObject({ state: "stopped", stopReason: "expired" })
    })
  })


  test("route deletion cancels timers before publishing the tombstone", async () => {
    await withAutomationApp(async ({ app, projectID }) => {
      const cancelled: string[] = []
      AutomationScheduler.install({
        stop: () => undefined,
        settleOwner: async () => undefined,
        reschedule: () => undefined,
        cancel: (automationID) => cancelled.push(automationID),
        computeNextFireAt: () => null,
      })

      const created = await json(app, "/automation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(recurringInput(projectID)),
      })
      await json(app, `/automation/${created.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Updated brief" }),
      })
      await json(app, `/automation/${created.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
      await json(app, `/automation/${created.id}/pause`, { method: "POST" })
      await json(app, `/automation/${created.id}`, { method: "DELETE" })

      expect(cancelled).toEqual([created.id])
    })
  })

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
      expect(body.model).toEqual(fixtureModel)
      expect(body.nextFireAt).toBeNumber()
      expect(body.nextFires).toHaveLength(3)
      expect(body.failureStreak).toBe(0)
    })
  })

  test("create settles the scheduler before publishing definition updates", async () => {
    await withAutomationApp(async ({ app, projectID }) => {
      const settleStarted = deferred<void>()
      const releaseSettle = deferred<void>()
      const publication = deferred<string>()
      let publishedID: string | undefined
      const unsubscribe = Bus.subscribe(Automation.Event.DefinitionUpdated, (event) => {
        publishedID = event.properties.id
        publication.resolve(event.properties.id)
      })
      AutomationScheduler.install({
        stop: () => undefined,
        settleOwner: async () => {
          settleStarted.resolve()
          await releaseSettle.promise
        },
        reschedule: () => undefined,
        cancel: () => undefined,
        computeNextFireAt: () => null,
      })

      try {
        const create = json(app, "/automation", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(oneshotInput(projectID)),
        })
        await settleStarted.promise
        await Bun.sleep(1)

        expect(publishedID).toBeUndefined()

        releaseSettle.resolve()
        const created = await create
        const emittedID = await publication.promise
        expect(publishedID).toBe(created.id)
        expect(emittedID).toBe(created.id)
      } finally {
        releaseSettle.resolve()
        unsubscribe()
      }
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

  test("accepts fresh worktree placement for git projects", async () => {
    await withAutomationApp(async ({ app, projectID }) => {
      const body = await json(app, "/automation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(recurringInput(projectID, { where: { projectID, worktree: "daily-brief" } })),
      })

      expect(body.where).toEqual({ projectID, worktree: "daily-brief" })
    })
  })

  test("normalizes worktree placement before echoing the definition", async () => {
    await withAutomationApp(async ({ app, projectID }) => {
      const body = await json(app, "/automation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(recurringInput(projectID, { where: { projectID, worktree: "Daily Brief!" } })),
      })

      expect(body.where).toEqual({ projectID, worktree: "daily-brief" })
    })
  })

  test("rejects worktree placement that cannot be normalized to a slug", async () => {
    await withAutomationApp(async ({ app, projectID }) => {
      const response = await app.request("/automation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(recurringInput(projectID, { where: { projectID, worktree: "!!!" } })),
      })
      const body = await response.json()

      expect(response.status).toBe(422)
      expect(body.details).toEqual([{ field: "where.worktree", message: "invalid_worktree_placement" }])
    })
  })

  test("rejects continue worktree placement", async () => {
    await withAutomationApp(async ({ app, projectID }) => {
      const response = await app.request("/automation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          recurringInput(projectID, { context: "continue", where: { projectID, worktree: "daily-brief" } }),
        ),
      })
      const body = await response.json()

      expect(response.status).toBe(422)
      // Via HTTP a continue create is doubly invalid: it cannot combine a worktree
      // with continue, and it has no bindable source. Both reasons are reported.
      expect(body.details).toEqual([
        { field: "context", message: "unsupported_continue_with_worktree" },
        { field: "context", message: "unsupported_continue_without_source" },
      ])
    })
  })

  test("rejects worktree placement for non-git projects", async () => {
    await withAutomationApp(
      async ({ app, projectID }) => {
        const response = await app.request("/automation", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(recurringInput(projectID, { where: { projectID, worktree: "daily-brief" } })),
        })
        const body = await response.json()

        expect(response.status).toBe(422)
        expect(body.details).toEqual([{ field: "where.worktree", message: "unsupported_where_worktree_not_git" }])
      },
      { git: false },
    )
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
          "impossible cron date without weekday fallback",
          recurringInput(projectID, { rhythm: { kind: "cron", expression: "0 0 31 2 *" } }),
          [{ field: "rhythm.expression", message: "invalid_cron_expression" }],
        ],
        [
          "invalid timezone",
          recurringInput(projectID, { timezone: "Mars/Olympus" }),
          [{ field: "timezone", message: "invalid_timezone" }],
        ],
        [
          "interval below floor",
          recurringInput(projectID, { rhythm: { kind: "interval", everyMs: 29_999 } }),
          [{ field: "rhythm.everyMs", message: "interval_below_minimum_30000ms" }],
        ],
        [
          "title above replay-safe limit",
          recurringInput(projectID, { title: "x".repeat(161) }),
          [{ field: "title", message: "title_too_long_160" }],
        ],
        [
          "prompt above replay-safe limit",
          recurringInput(projectID, { prompt: "x".repeat(20_001) }),
          [{ field: "prompt", message: "prompt_too_long_20000" }],
        ],
        [
          "stop kind condition rejected with structured detail",
          recurringInput(projectID, { stop: { kind: "condition", condition: "repo is ready" } }),
          [{ field: "stop", message: "unsupported_stop_condition" }],
        ],
        [
          "condition above replay-safe limit",
          recurringInput(projectID, { stop: { kind: "condition", condition: "x".repeat(4_001) } }),
          [{ field: "stop.condition", message: "condition_too_long_4000" }],
        ],
        [
          "externally supplied source session",
          { ...recurringInput(projectID), sourceSessionID: SessionID.descending() },
          [{ field: "sourceSessionID", message: "unsupported_automation_field" }],
        ],
        [
          "continue without a bindable source",
          recurringInput(projectID, { context: "continue" }),
          [{ field: "context", message: "unsupported_continue_without_source" }],
        ],
        [
          "oneshot fireAt in the past",
          oneshotInput(projectID, { fireAt: 1 }),
          [{ field: "fireAt", message: "fireAt_must_be_future" }],
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
        [
          "unknown nested create knob",
          { ...recurringInput(projectID), where: { projectID, unexpected: true } },
          [{ field: "where.unexpected", message: "unsupported_automation_field" }],
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

  test("PUT rejects stop kind 'condition' with structured unsupported_stop_condition detail", async () => {
    await withAutomationApp(async ({ app, projectID }) => {
      const created = await json(app, "/automation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(recurringInput(projectID)),
      })
      const response = await app.request(`/automation/${created.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stop: { kind: "condition", condition: "repo is ready" } }),
      })
      expect(response.status).toBe(422)
      expect(await response.json()).toEqual({
        error: "invalid_automation",
        details: [{ field: "stop", message: "unsupported_stop_condition" }],
      })
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

  test("delete removes the definition while a live run is owned by another process", async () => {
    await withAutomationApp(async ({ app, projectID }) => {
      const created = Automation.create(recurringInput(projectID), { now: 100 })
      const active = Automation.runNow(created.id, { now: 200 })
      await using _ = await Flock.acquire(`automation-run:${Instance.directory}:${active.id}`)

      const deleted = await json(app, `/automation/${created.id}`, { method: "DELETE" })

      expect(deleted).toEqual({ id: created.id, deleted: true, revision: 2 })
      expect(() => Automation.get(created.id)).toThrow()
      const row = Database.use((db) => db.select().from(AutomationRunTable).where(eq(AutomationRunTable.id, active.id)).get())
      expect(row ? Automation.Run.parse(row.data) : undefined).toMatchObject({
        id: active.id,
        state: "scheduled",
      })
    })
  })

  test("delete returns 404 for an unknown automation", async () => {
    await withAutomationApp(async ({ app }) => {
      const response = await app.request(`/automation/${AutomationID.Definition.ascending()}`, { method: "DELETE" })
      expect(response.status).toBe(404)
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

  test("rejects externally supplied source session on update", async () => {
    await withAutomationApp(async ({ app, projectID }) => {
      const created = await json(app, "/automation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(recurringInput(projectID)),
      })
      const sourceResponse = await app.request(`/automation/${created.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceSessionID: SessionID.descending() }),
      })

      expect(sourceResponse.status).toBe(422)
      expect(await sourceResponse.json()).toEqual({
        error: "invalid_automation",
        details: [{ field: "sourceSessionID", message: "unsupported_automation_field" }],
      })
      expect(Automation.get(created.id)).not.toHaveProperty("sourceSessionID")
    })
  })

  test("rejects switching a fresh automation to continue on update", async () => {
    await withAutomationApp(async ({ app, projectID }) => {
      const created = await json(app, "/automation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(recurringInput(projectID)),
      })
      const response = await app.request(`/automation/${created.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ context: "continue" }),
      })
      expect(response.status).toBe(422)
      expect(await response.json()).toEqual({
        error: "invalid_automation",
        details: [{ field: "context", message: "unsupported_context_change" }],
      })
      expect(Automation.get(created.id).context).toBe("fresh")
    })
  })

  test("rejects switching a continue automation to fresh on update and keeps the source binding", async () => {
    await withAutomationApp(async ({ app, projectID }) => {
      // A continue automation can only be created with a source (the tool path),
      // so seed one directly rather than through the source-less HTTP create.
      const sourceSessionID = SessionID.descending()
      const created = Automation.create(recurringInput(projectID, { context: "continue" }), { sourceSessionID })
      expect(created.sourceSessionID).toBe(sourceSessionID)

      const response = await app.request(`/automation/${created.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ context: "fresh" }),
      })

      expect(response.status).toBe(422)
      expect(await response.json()).toEqual({
        error: "invalid_automation",
        details: [{ field: "context", message: "unsupported_context_change" }],
      })
      // The rejected switch must not strip the source the continue run depends on.
      const after = Automation.get(created.id)
      expect(after.context).toBe("continue")
      expect(after.sourceSessionID).toBe(sourceSessionID)
    })
  })

  test("moves a fresh automation to another project without changing its id or run history", async () => {
    await using source = await tmpdir({ git: true })
    await using target = await tmpdir({ git: true })
    let targetProjectID: ProjectID | undefined
    await Instance.provide({
      directory: target.path,
      fn: () => {
        targetProjectID = Instance.project.id
      },
    })
    await Instance.disposeAll({ mode: "force" })

    let automationID = ""
    let runID = ""
    await Instance.provide({
      directory: source.path,
      fn: async () => {
        const app = new Hono().route("/automation", AutomationRoutes())
        app.onError(ErrorMiddleware)
        const sourceProjectID = Instance.project.id
        if (!targetProjectID) throw new Error("expected target project")
        const created = Automation.create(recurringInput(sourceProjectID), { now: 100 })
        if (created.kind !== "recurring") throw new Error("expected recurring automation")
        await Automation.runNowExecuting(created.id, {
          now: 200,
          executor: async () => ({ sessionID: SessionID.descending(), result: "done", cost: 0 }),
        })
        const run = await waitForRunState(created.id, "succeeded")
        automationID = created.id
        runID = run.id

        const response = await app.request(`/automation/${created.id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ where: { projectID: targetProjectID } }),
        })
        const moved = await response.json()

        expect(response.status).toBe(200)
        expect(moved).toMatchObject({
          id: created.id,
          revision: 2,
          where: { projectID: targetProjectID },
          rhythm: created.rhythm,
          stop: created.stop,
        })
        expect(() => Automation.get(created.id)).toThrow()
      },
    })

    await Instance.provide({
      directory: target.path,
      fn: () => {
        if (!targetProjectID) throw new Error("expected target project")
        const moved = Automation.get(automationID)
        expect(moved.id).toBe(automationID)
        expect(moved.where.projectID).toBe(targetProjectID)
        expect(Automation.runs({ automationID }).items.map((run) => run.id)).toEqual([runID])
      },
    })
  })

  test("rejects moving a fresh automation to an unknown project", async () => {
    await withAutomationApp(async ({ app, projectID }) => {
      const created = Automation.create(recurringInput(projectID), { now: 100 })

      const response = await app.request(`/automation/${created.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ where: { projectID: ProjectID.make("project-missing") } }),
      })

      expect(response.status).toBe(422)
      expect(await response.json()).toEqual({
        error: "invalid_automation",
        details: [{ field: "where.projectID", message: "project_not_found" }],
      })
      expect(Automation.get(created.id).where.projectID).toBe(projectID)
    })
  })

  test("rejects moving a fresh automation while it has an active run", async () => {
    await using source = await tmpdir({ git: true })
    await using target = await tmpdir({ git: true })
    let targetProjectID: ProjectID | undefined
    await Instance.provide({
      directory: target.path,
      fn: () => {
        targetProjectID = Instance.project.id
      },
    })
    await Instance.disposeAll({ mode: "force" })

    await Instance.provide({
      directory: source.path,
      fn: async () => {
        const app = new Hono().route("/automation", AutomationRoutes())
        app.onError(ErrorMiddleware)
        if (!targetProjectID) throw new Error("expected target project")
        const created = Automation.create(recurringInput(Instance.project.id), { now: 100 })
        const active = Automation.runNow(created.id, { now: 200 })
        await using _lease = await Flock.acquire(`automation-run:${Instance.directory}:${active.id}`)

        const response = await app.request(`/automation/${created.id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ where: { projectID: targetProjectID } }),
        })

        expect(response.status).toBe(422)
        expect(await response.json()).toEqual({
          error: "invalid_automation",
          details: [{ field: "where.projectID", message: "unsupported_move_with_active_run" }],
        })
        expect(Automation.get(created.id).where.projectID).toBe(Instance.project.id)
      },
    })
  })

  test("rejects moving a continue automation to another project", async () => {
    await using source = await tmpdir({ git: true })
    await using target = await tmpdir({ git: true })
    let targetProjectID: ProjectID | undefined
    await Instance.provide({
      directory: target.path,
      fn: () => {
        targetProjectID = Instance.project.id
      },
    })
    await Instance.disposeAll({ mode: "force" })

    await Instance.provide({
      directory: source.path,
      fn: async () => {
        const app = new Hono().route("/automation", AutomationRoutes())
        app.onError(ErrorMiddleware)
        if (!targetProjectID) throw new Error("expected target project")
        const created = Automation.create(recurringInput(Instance.project.id, { context: "continue" }), {
          sourceSessionID: SessionID.descending(),
        })

        const response = await app.request(`/automation/${created.id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ where: { projectID: targetProjectID } }),
        })

        expect(response.status).toBe(422)
        expect(await response.json()).toEqual({
          error: "invalid_automation",
          details: [{ field: "where.projectID", message: "unsupported_continue_move" }],
        })
        expect(Automation.get(created.id).where.projectID).toBe(Instance.project.id)
      },
    })
  })

  test("rejects updating a oneshot fireAt into the past without revising", async () => {
    await withAutomationApp(async ({ app, projectID }) => {
      const created = await json(app, "/automation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(oneshotInput(projectID)),
      })
      const response = await app.request(`/automation/${created.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fireAt: 1 }),
      })

      expect(response.status).toBe(422)
      expect(await response.json()).toEqual({
        error: "invalid_automation",
        details: [{ field: "fireAt", message: "fireAt_must_be_future" }],
      })
      expect(Automation.get(created.id).revision).toBe(1)
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

  test("metadata-only update preserves pending nextFireAt and nextFires", async () => {
    await withAutomationApp(async ({ projectID }) => {
      const created = Automation.create(recurringInput(projectID), { now: 100 })
      expect(created.kind).toBe("recurring")
      if (created.kind !== "recurring") throw new Error("recurring")
      const updated = Automation.update(created.id, { title: "Renamed" }, { now: 200 })
      expect(updated).toMatchObject({
        title: "Renamed",
        nextFireAt: created.nextFireAt,
        nextFires: created.nextFires,
      })
    })
  })

  test("rhythm change recomputes nextFireAt from the update timestamp", async () => {
    await withAutomationApp(async ({ projectID }) => {
      const created = Automation.create(recurringInput(projectID), { now: 100 })
      const updated = Automation.update(
        created.id,
        { rhythm: { kind: "interval", everyMs: 120_000 } },
        { now: 300 },
      )
      if (updated.kind !== "recurring") throw new Error("recurring")
      expect(updated.nextFireAt).toBe(300 + 120_000)
    })
  })

  test("update accepts variant: null to clear a previously set effort", async () => {
    await withAutomationApp(async ({ app, projectID }) => {
      const created = await json(app, "/automation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(recurringInput(projectID, { variant: "high" } as Partial<RecurringCreateInput>)),
      })
      expect(created.variant).toBe("high")
      const cleared = await json(app, `/automation/${created.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ variant: null }),
      })
      expect(cleared).not.toHaveProperty("variant")
      expect(Automation.get(created.id)).not.toHaveProperty("variant")
    })
  })

  test("update with variant: null on an unset variant is a no-op (no revision bump, no event)", async () => {
    await withAutomationApp(async ({ app, projectID }) => {
      const created = await json(app, "/automation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(recurringInput(projectID)),
      })
      expect(created).not.toHaveProperty("variant")
      const updates: number[] = []
      const unsubscribe = Bus.subscribe(Automation.Event.DefinitionUpdated, (event) => {
        if (event.properties.id === created.id) updates.push(event.properties.revision)
      })
      const noop = await json(app, `/automation/${created.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ variant: null }),
      })
      await Bun.sleep(10)
      unsubscribe()
      expect(noop.revision).toBe(created.revision)
      expect(noop.updatedAt).toBe(created.updatedAt)
      expect(updates).toEqual([])
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
    const update409 = paths["/automation/{automationID}"].put.responses["409"].content["application/json"].schema
    const pause409 = paths["/automation/{automationID}/pause"].post.responses["409"].content["application/json"].schema
    const resume409 = paths["/automation/{automationID}/resume"].post.responses["409"].content["application/json"].schema
    const deleteResponses = paths["/automation/{automationID}"].delete.responses

    expect(create422).toEqual({ $ref: "#/components/schemas/AutomationValidationError" })
    expect(update422).toEqual({ $ref: "#/components/schemas/AutomationValidationError" })
    expect(update409).toEqual({ $ref: "#/components/schemas/AutomationConflictError" })
    expect(pause409).toEqual({ $ref: "#/components/schemas/AutomationConflictError" })
    expect(resume409).toEqual({ $ref: "#/components/schemas/AutomationConflictError" })
    expect(deleteResponses).not.toHaveProperty("409")
    expect(spec.components?.schemas).toHaveProperty("AutomationValidationError")
    expect(spec.components?.schemas).toHaveProperty("AutomationConflictError")
    expect(spec.components?.schemas).not.toHaveProperty("AutomationActiveRunStillRunningError")
  })

  test("openapi describes delete as preserving already-started runs", async () => {
    const { Server } = await import("../../src/server/server")
    const spec = await Server.openapi()
    const paths = spec.paths as Record<string, any>
    const description = paths["/automation/{automationID}"].delete.description

    expect(description).toContain("Already-started runs continue")
    expect(description).not.toContain("publish the stopped run")
    expect(description).not.toContain("live run is owned by another process")
  })

  test("runNow returns the queued run before background execution updates it", async () => {
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
        definitionRevision: 1,
        state: "scheduled",
      })
      expect(run.id).toMatch(/^automation_run_/)
      expect(run.sessionID).toBeNull()
    })
  })

  test("runNow records the automation definition revision used for the run", async () => {
    await withAutomationApp(async ({ app, projectID }) => {
      const created = await json(app, "/automation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(recurringInput(projectID)),
      })
      const updated = await json(app, `/automation/${created.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Updated brief" }),
      })
      const run = await json(app, `/automation/${created.id}/run`, { method: "POST" })

      expect(updated.revision).toBe(2)
      expect(run.definitionRevision).toBe(2)
      expect(run.revision).toBe(1)
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
    const runSessionID = SessionID.descending()
    expect(() =>
      Automation.Run.parse({
        id: AutomationID.Run.ascending(),
        automationID: AutomationID.Definition.ascending(),
        revision: 1,
        definitionRevision: 1,
        state: "failed",
        triggeredAt: 1,
        startedAt: 1,
        completedAt: 2,
        sessionID: runSessionID,
        result: null,
        error: { code: "step_cap", message: "Stopped after reaching the automation step cap." },
        cost: null,
      }),
    ).not.toThrow()

    expect(() =>
      Automation.Run.parse({
        id: AutomationID.Run.ascending(),
        automationID: AutomationID.Definition.ascending(),
        revision: 1,
        definitionRevision: 1,
        state: "stopped",
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
        definitionRevision: 1,
        state: "stopped",
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

  test("schemas reject definition and tombstone contract drift fields", () => {
    return withAutomationApp(async ({ projectID }) => {
      const recurring = Automation.create(recurringInput(projectID))
      const oneshot = Automation.create(oneshotInput(projectID))

      expect(() => Automation.Definition.parse({ ...recurring, unexpected: true })).toThrow()
      expect(() => Automation.Definition.parse({ ...oneshot, unexpected: true })).toThrow()
      expect(() => Automation.Definition.parse({ ...recurring, title: "" })).toThrow()
      expect(() => Automation.Definition.parse({ ...recurring, prompt: "" })).toThrow()
      expect(() => Automation.Definition.parse({ ...recurring, timezone: "" })).toThrow()
      expect(() => Automation.Tombstone.parse({ id: recurring.id, deleted: true, revision: 2, unexpected: true })).toThrow()
    })
  })

  test("schemas reject nested automation contract drift fields", () => {
    return withAutomationApp(async ({ projectID }) => {
      const where = { projectID, unexpected: true } as Record<string, unknown>
      const rhythm = { kind: "interval", everyMs: 60_000, unexpected: true } as Record<string, unknown>
      const stop = { kind: "count", count: 3, unexpected: true } as Record<string, unknown>

      expect(() => Automation.CreateInput.parse({ ...recurringInput(projectID), where })).toThrow()
      expect(() => Automation.CreateInput.parse({ ...recurringInput(projectID), rhythm })).toThrow()
      expect(() => Automation.CreateInput.parse({ ...recurringInput(projectID), stop })).toThrow()
      expect(() =>
        Automation.Run.parse(
          run({
            state: "failed",
            sessionID: SessionID.descending(),
            startedAt: 1,
            completedAt: 2,
            error: { code: "execution_failed", message: "failed", unexpected: true },
          }),
        ),
      ).toThrow()
    })
  })

  test("schemas freeze run state consistency", () => {
    const runSessionID = SessionID.descending()
    const permissionBlocker = {
      kind: "permission" as const,
      requestID: PermissionID.ascending(),
    }
    const questionBlocker = {
      kind: "question" as const,
      callID: "call_123",
    }
    const error = { code: "execution_failed" as const, message: "failed" }

    expect(() => Automation.Run.parse(run({ state: "scheduled" }))).not.toThrow()
    expect(() => Automation.Run.parse(run({ state: "running", sessionID: runSessionID, startedAt: 1 }))).not.toThrow()
    expect(() =>
      Automation.Run.parse(run({ state: "awaiting_input", sessionID: runSessionID, startedAt: 1, blocker: permissionBlocker })),
    ).not.toThrow()
    expect(() =>
      Automation.Run.parse(run({ state: "awaiting_input", sessionID: runSessionID, startedAt: 1, blocker: questionBlocker })),
    ).not.toThrow()
    expect(() =>
      Automation.Run.parse(run({ state: "succeeded", sessionID: runSessionID, startedAt: 1, completedAt: 2, result: "done" })),
    ).not.toThrow()
    expect(() => Automation.Run.parse(run({ state: "failed", sessionID: runSessionID, startedAt: 1, completedAt: 2, error }))).not.toThrow()
    expect(() =>
      Automation.Run.parse(run({ state: "stopped", completedAt: 2, stopReason: "previous_run_awaiting_input" })),
    ).not.toThrow()
    expect(() =>
      Automation.Run.parse(run({ state: "stopped", completedAt: 2, stopReason: "missed_schedule" })),
    ).not.toThrow()

    expect(() => Automation.Run.parse(run({ state: "awaiting_input", startedAt: 1 }))).toThrow()
    expect(() => Automation.Run.parse(run({ state: "running", sessionID: null, startedAt: 1 }))).toThrow()
    expect(() => Automation.Run.parse(run({ state: "awaiting_input", sessionID: null, startedAt: 1, blocker: permissionBlocker }))).toThrow()
    expect(() => Automation.Run.parse(run({ state: "succeeded", sessionID: null, startedAt: 1, completedAt: 2, result: "done" }))).toThrow()
    expect(() => Automation.Run.parse(run({ state: "failed", sessionID: null, startedAt: 1, completedAt: 2, error }))).toThrow()
    expect(() => Automation.Run.parse(run({ state: "running", sessionID: runSessionID, startedAt: 0, triggeredAt: 1 }))).toThrow()
    expect(() => Automation.Run.parse(run({ state: "succeeded", sessionID: runSessionID, startedAt: 2, completedAt: 1 }))).toThrow()
    expect(() => Automation.Run.parse(run({ state: "stopped", completedAt: 0, triggeredAt: 1, stopReason: "cancelled" }))).toThrow()
    expect(() => Automation.Run.parse(run({ state: "awaiting_input", sessionID: runSessionID, startedAt: 1, blocker: { kind: "permission", sessionID: SessionID.descending(), requestID: PermissionID.ascending() } }))).toThrow()
    expect(() => Automation.Run.parse(run({ state: "awaiting_input", sessionID: runSessionID, startedAt: 1, blocker: { kind: "question", sessionID: SessionID.descending(), callID: "call_123" } }))).toThrow()
    expect(() => Automation.Run.parse(run({ state: "running", startedAt: 1, blocker: permissionBlocker }))).toThrow()
    expect(() => Automation.Run.parse(run({ state: "running" }))).toThrow()
    expect(() => Automation.Run.parse(run({ state: "running", startedAt: 1, completedAt: 2 }))).toThrow()
    expect(() => Automation.Run.parse(run({ state: "running", startedAt: 1, error }))).toThrow()
    expect(() => Automation.Run.parse(run({ state: "succeeded", completedAt: 2, result: "done" }))).toThrow()
    expect(() => Automation.Run.parse(run({ state: "succeeded", startedAt: 1, completedAt: 2, error }))).toThrow()
    expect(() => Automation.Run.parse(run({ state: "scheduled", completedAt: 2 }))).toThrow()
    expect(() => Automation.Run.parse(run({ state: "scheduled", result: "done" }))).toThrow()
    expect(() => Automation.Run.parse(run({ state: "skipped", completedAt: 2, skipReason: "previous_run_awaiting_input" }))).toThrow()
    expect(() => Automation.Run.parse(run({ state: "expired", completedAt: 2, stopReason: "blocker_lost" }))).toThrow()
    expect(() => Automation.Run.parse(run({ state: "stopped", completedAt: 2 }))).toThrow()
    expect(() => Automation.Run.parse(run({ state: "stopped", completedAt: 2, stopReason: "step_cap" }))).toThrow()
    expect(() => Automation.Run.parse(run({ state: "failed", startedAt: 1, completedAt: null, error }))).toThrow()
    expect(() => Automation.Run.parse(run({ state: "failed", startedAt: 1, completedAt: 2 }))).toThrow()
    expect(() => Automation.Run.parse(run({ state: "failed", sessionID: runSessionID, startedAt: 1, completedAt: 2, error, stopReason: "loop_gate" }))).toThrow()
    expect(() => Automation.Run.parse(run({ state: "failed", sessionID: runSessionID, startedAt: 1, completedAt: 2, error: { code: "unsupported_where_worktree", message: "bad" } }))).toThrow()
  })
})
