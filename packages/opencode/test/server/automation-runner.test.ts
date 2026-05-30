import path from "path"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Automation } from "../../src/automation"
import { sessionPromptExecutor } from "../../src/automation/runner"
import { AutomationRunTable } from "../../src/automation/automation.sql"
import { Bus } from "../../src/bus"
import { Database, eq } from "../../src/storage/db"
import { Instance } from "../../src/project/instance"
import { ProjectID } from "../../src/project/schema"
import { Session } from "../../src/session"
import { SessionID } from "../../src/session/schema"
import { AutomationRunContext, AutomationStepCapError } from "../../src/automation/run-context"
import { Flock } from "../../src/util/flock"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

async function withAutomation<T>(fn: (projectID: ProjectID) => Promise<T>) {
  await using tmp = await tmpdir({ git: true })
  return await Instance.provide({
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

async function waitForRunCount(automationID: string, count: number) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const items = Automation.runs({ automationID, limit: 100 }).items
    if (items.length >= count) return items
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${count} automation runs`)
}

async function waitForSucceededRunCount(automationID: string, count: number) {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const items = Automation.runs({ automationID, limit: 100 }).items
    const succeeded = items.filter((run) => run.state === "succeeded")
    if (succeeded.length >= count) return succeeded
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${count} succeeded automation runs`)
}

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function hangingChat(ready: () => void) {
  const encoder = new TextEncoder()
  let timer: ReturnType<typeof setTimeout> | undefined
  const first = `data: ${JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    choices: [{ delta: { role: "assistant" } }],
  })}\n\n`
  const rest =
    [
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: { content: "late" } }],
      })}`,
      `data: ${JSON.stringify({
        id: "chatcmpl-1",
        object: "chat.completion.chunk",
        choices: [{ delta: {}, finish_reason: "stop" }],
      })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"

  return new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(encoder.encode(first))
      ready()
      timer = setTimeout(() => {
        ctrl.enqueue(encoder.encode(rest))
        ctrl.close()
      }, 10_000)
    },
    cancel() {
      if (timer) clearTimeout(timer)
    },
  })
}

async function waitForAbortedAssistant(sessionID: SessionID) {
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    const messages = await Session.messages({ sessionID })
    const assistant = messages.findLast((message) => message.info.role === "assistant")
    if (assistant?.info.role === "assistant" && assistant.info.error?.name === "MessageAbortedError") return assistant
    await Bun.sleep(10)
  }
  throw new Error("Timed out waiting for aborted assistant message")
}

describe("automation runNow execution", () => {
  test("executes a run and records the terminal result", async () => {
    await withAutomation(async (projectID) => {
      const definition = Automation.create(input(projectID))
      const sessionID = SessionID.descending()

      const initial = await Automation.runNowExecuting(definition.id, {
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

  test("does not publish duplicate running events when the executor already started the run", async () => {
    await withAutomation(async (projectID) => {
      const definition = Automation.create(input(projectID))
      const sessionID = SessionID.descending()
      const runEvents: Automation.Run[] = []
      const unsubscribeRun = Bus.subscribe(Automation.Event.RunUpdated, (event) => {
        if (event.properties.automationID === definition.id) runEvents.push(event.properties)
      })

      await Automation.runNowExecuting(definition.id, {
        executor: async ({ run }) => {
          const started = Automation.markRunStarted(run, sessionID, { now: run.triggeredAt })
          await Automation.publishRunUpdated(started)
          return { sessionID, result: "done", cost: 0 }
        },
      })

      await waitForRun(definition.id, "succeeded")
      unsubscribeRun()
      expect(runEvents.map((event) => event.state)).toEqual(["running", "succeeded"])
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

      await Automation.runNowExecuting(first.id, {
        executor: async () => {
          entered++
          await held
          return { sessionID: SessionID.descending(), result: "first", cost: 0 }
        },
      })
      await Automation.runNowExecuting(second.id, {
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

  test("blocks a run when durable storage already has an active run for the project", async () => {
    await withAutomation(async (projectID) => {
      const first = Automation.create(input(projectID, { title: "First automation" }))
      const second = Automation.create(input(projectID, { title: "Second automation" }))
      const active = Automation.runNow(first.id, { now: 100 })
      await using _ = await Flock.acquire(`automation-run:${Instance.directory}:${active.id}`)
      let entered = false

      await Automation.runNowExecuting(second.id, {
        now: 200,
        executor: async () => {
          entered = true
          return { sessionID: SessionID.descending(), result: "second", cost: 0 }
        },
      })

      const stopped = await waitForRun(second.id, "stopped")
      if (stopped.state !== "stopped") throw new Error("expected stopped run")
      expect(stopped.stopReason).toBe("previous_run_awaiting_input")
      expect(entered).toBe(false)
    })
  })

  test("reconciles stale durable writers before executing a manual run", async () => {
    await withAutomation(async (projectID) => {
      const first = Automation.create(input(projectID, { title: "Stale writer" }))
      const second = Automation.create(input(projectID, { title: "Manual run" }))
      const stale = Automation.runNow(first.id, { now: 100 })
      let entered = false

      await Automation.runNowExecuting(second.id, {
        now: 200,
        executor: async () => {
          entered = true
          return { sessionID: SessionID.descending(), result: "second", cost: 0 }
        },
      })

      const succeeded = await waitForRun(second.id, "succeeded")
      expect(entered).toBe(true)
      expect(succeeded.result).toBe("second")
      expect(Automation.runs({ automationID: first.id }).items[0]).toMatchObject({
        id: stale.id,
        state: "stopped",
        stopReason: "expired",
      })
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

      await Automation.runNowExecuting(definition.id, {
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
      await Automation.runNowExecuting(definition.id, {
        executor: async () => {
          await held
          return { sessionID: SessionID.descending(), result: "first", cost: 0 }
        },
      })
      await Automation.runNowExecuting(definition.id, {
        executor: async () => ({ sessionID: SessionID.descending(), result: "second", cost: 0 }),
      })
      const stopped = await waitForRun(definition.id, "stopped")
      if (stopped.completedAt === null) throw new Error("expected stopped run to have completedAt")
      const restarted = Automation.markRunStarted(stopped, SessionID.descending(), { now: stopped.completedAt })
      expect(restarted).not.toHaveProperty("stopReason")
      release()
    })
  })

  test("does not let stale active snapshots overwrite terminal runs", async () => {
    await withAutomation(async (projectID) => {
      const definition = Automation.create(input(projectID))
      const scheduled = Automation.runNow(definition.id, { now: 100 })
      const stopped = Automation.stopRunByID(scheduled.id, "cancelled", { now: 200 })

      expect(stopped).toMatchObject({ state: "stopped", revision: 2 })
      const staleStarted = Automation.markRunStarted(scheduled, SessionID.descending(), { now: 300 })

      expect(staleStarted).toMatchObject({ state: "stopped", revision: 2, stopReason: "cancelled" })
      expect(Automation.runs({ automationID: definition.id }).items[0]).toMatchObject({
        state: "stopped",
        revision: 2,
        stopReason: "cancelled",
      })
    })
  })

  test("does not publish execution updates after the durable run row disappears", async () => {
    await withAutomation(async (projectID) => {
      const definition = Automation.create(input(projectID))
      const runEvents: Automation.Run[] = []
      const executorFinished = defer<void>()
      const unsubscribeRun = Bus.subscribe(Automation.Event.RunUpdated, (event) => {
        if (event.properties.automationID === definition.id) runEvents.push(event.properties)
      })

      await Automation.runNowExecuting(definition.id, {
        executor: async ({ run }) => {
          Database.use((db) => db.delete(AutomationRunTable).where(eq(AutomationRunTable.id, run.id)).run())
          executorFinished.resolve()
          return { sessionID: SessionID.descending(), result: "done", cost: 0 }
        },
      })
      await executorFinished.promise
      await Bun.sleep(50)
      unsubscribeRun()

      expect(runEvents).toEqual([])
      expect(Automation.runs({ automationID: definition.id }).items).toEqual([])
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

      await Automation.runNowExecuting(definition.id, {
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
      let removed!: Awaited<ReturnType<typeof Automation.remove>>

      await Automation.runNowExecuting(definition.id, {
        executor: async () => {
          removed = await Automation.remove(definition.id)
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
      const runEvents: Automation.Run[] = []
      const unsubscribeRun = Bus.subscribe(Automation.Event.RunUpdated, (event) => {
        if (event.properties.automationID === definition.id) runEvents.push(event.properties)
      })

      await Automation.runNowExecuting(definition.id, {
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
      const removed = await Automation.remove(definition.id)

      expect(sawAbort).toBe(true)
      expect(removed.stoppedRun).toMatchObject({
        state: "stopped",
        sessionID,
        stopReason: "cancelled",
      })
      await Bun.sleep(20)
      unsubscribeRun()
      expect(runEvents.some((event) => event.state === "succeeded")).toBe(false)
    })
  })

  test("deleting an active automation cancels the real session prompt", async () => {
    const ready = defer<void>()
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
        return new Response(hangingChat(() => ready.resolve()), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      },
    })

    try {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              enabled_providers: ["alibaba"],
              provider: {
                alibaba: {
                  options: {
                    apiKey: "test-key",
                    baseURL: `${server.url.origin}/v1`,
                  },
                },
              },
              agent: {
                build: {
                  model: "alibaba/qwen-plus",
                },
              },
            }),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const definition = Automation.create(input(Instance.project.id, { title: "Cancel real prompt" }))

          await Automation.runNowExecuting(definition.id, { executor: sessionPromptExecutor })
          await ready.promise

          const removed = await Automation.remove(definition.id)
          const stoppedRun = removed.stoppedRun
          expect(stoppedRun).toMatchObject({ state: "stopped", stopReason: "cancelled" })
          if (!stoppedRun?.sessionID) throw new Error("expected stopped run to keep its sessionID")

          await waitForAbortedAssistant(stoppedRun.sessionID)
        },
      })
    } finally {
      void server.stop(true)
    }
  })

  test("executes fresh worktree runs from the managed worktree directory", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
        return Response.json({
          id: "chatcmpl-1",
          object: "chat.completion",
          choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      },
    })

    try {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              enabled_providers: ["alibaba"],
              provider: {
                alibaba: {
                  options: {
                    apiKey: "test-key",
                    baseURL: `${server.url.origin}/v1`,
                  },
                },
              },
              agent: {
                build: {
                  model: "alibaba/qwen-plus",
                },
              },
            }),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const definition = Automation.create(
            input(Instance.project.id, {
              title: "Worktree prompt",
              where: { projectID: Instance.project.id, worktree: "daily-brief" },
            }),
          )

          await Automation.runNowExecuting(definition.id, { executor: sessionPromptExecutor })

          const succeeded = await waitForRun(definition.id, "succeeded")
          if (!succeeded.sessionID) throw new Error("expected run session")
          const session = await Session.get(succeeded.sessionID)
          expect(session.executionContext.ownerDirectory).toBe(tmp.path)
          expect(session.executionContext.activeWorktree).toMatchObject({
            name: "daily-brief",
            source: "created",
          })
          expect(session.executionContext.activeDirectory).toContain(path.join(".worktrees", "pawwork", "daily-brief"))
        },
      })
    } finally {
      void server.stop(true)
    }
  })

  test("can run the same worktree placement more than once", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
        return Response.json({
          id: "chatcmpl-1",
          object: "chat.completion",
          choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      },
    })

    try {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              enabled_providers: ["alibaba"],
              provider: {
                alibaba: {
                  options: {
                    apiKey: "test-key",
                    baseURL: `${server.url.origin}/v1`,
                  },
                },
              },
              agent: {
                build: {
                  model: "alibaba/qwen-plus",
                },
              },
            }),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const definition = Automation.create(
            input(Instance.project.id, {
              title: "Reusable worktree prompt",
              where: { projectID: Instance.project.id, worktree: "daily-brief" },
            }),
          )

          await Automation.runNowExecuting(definition.id, { executor: sessionPromptExecutor })
          await waitForRun(definition.id, "succeeded")
          await Automation.runNowExecuting(definition.id, { executor: sessionPromptExecutor })

          await waitForRunCount(definition.id, 2)
          await waitForSucceededRunCount(definition.id, 2)
        },
      })
    } finally {
      void server.stop(true)
    }
  })

  test("deleting after run start but before prompt runner is busy does not call the provider", async () => {
    let providerCalls = 0
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
        providerCalls++
        return new Response(hangingChat(() => undefined), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        })
      },
    })

    try {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(
            path.join(dir, "opencode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              enabled_providers: ["alibaba"],
              provider: {
                alibaba: {
                  options: {
                    apiKey: "test-key",
                    baseURL: `${server.url.origin}/v1`,
                  },
                },
              },
              agent: {
                build: {
                  model: "alibaba/qwen-plus",
                },
              },
            }),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const definition = Automation.create(input(Instance.project.id, { title: "Cancel before runner busy" }))
          const removed = Promise.withResolvers<Awaited<ReturnType<typeof Automation.remove>>>()
          const unsubscribe = Bus.subscribe(Automation.Event.RunUpdated, (event) => {
            if (event.properties.automationID !== definition.id || event.properties.state !== "running") return
            void Automation.remove(definition.id).then(removed.resolve, removed.reject)
          })

          await Automation.runNowExecuting(definition.id, { executor: sessionPromptExecutor })
          let result: Awaited<ReturnType<typeof Automation.remove>>
          try {
            result = await Promise.race([
              removed.promise,
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("timed out waiting for running run")), 1_000),
              ),
            ])
          } finally {
            unsubscribe()
          }

          expect(result.stoppedRun).toMatchObject({ state: "stopped", stopReason: "cancelled" })
          await Bun.sleep(50)
          expect(providerCalls).toBe(0)
          if (result.stoppedRun?.sessionID) {
            const messages = await Session.messages({ sessionID: result.stoppedRun.sessionID })
            expect(messages.some((message) => message.info.role === "assistant")).toBe(false)
          }
        },
      })
    } finally {
      void server.stop(true)
    }
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

      await Automation.runNowExecuting(definition.id, {
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
