import { afterEach, describe, expect, test } from "bun:test"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { Permission } from "../../src/permission"
import { Question } from "../../src/question"
import { Session } from "../../src/session"
import { SessionBlocker } from "../../src/session/blocker"
import { MessageID, SessionID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"
import type { Effect } from "effect"

afterEach(async () => {
  await Instance.disposeAll()
})

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => AppRuntime.runPromise(effect as never) as Promise<A>

async function createPendingQuestion(sessionID: SessionID) {
  const promise = run(
    Question.Service.use((svc) =>
      svc.ask({
        sessionID,
        questions: [
          {
            question: "Continue?",
            header: "Confirm",
            options: [
              { label: "Yes", description: "continue" },
              { label: "No", description: "stop" },
            ],
          },
        ],
        tool: { messageID: MessageID.make("msg_lifecycle_question"), callID: "call_lifecycle_question" },
      }),
    ),
  )
  await waitFor(async () => (await listQuestions()).length === 1)
  return { promise }
}

async function createPendingPermission(sessionID: SessionID) {
  const promise = run(
    Permission.Service.use((svc) =>
      svc.ask({
        sessionID,
        permission: "edit",
        patterns: ["/tmp/file.txt"],
        always: ["/tmp/file.txt"],
        metadata: {},
        ruleset: [{ permission: "edit", pattern: "*", action: "ask" }],
      }),
    ),
  )
  await waitFor(async () => (await listPermissions()).length === 1)
  return { promise }
}

const listQuestions = () => run(Question.Service.use((svc) => svc.list()))
const listPermissions = () => run(Permission.Service.use((svc) => svc.list()))
const listBlockers = () => run(SessionBlocker.Service.use((svc) => svc.list()))

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 1000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error("timed out waiting for condition")
}

describe("session pending interaction lifecycle", () => {
  test("deleting a session terminates question, permission, and blocker state", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await run(Session.Service.use((svc) => svc.create({})))
        const question = await createPendingQuestion(session.id)
        const permission = await createPendingPermission(session.id)

        expect(await listQuestions()).toHaveLength(1)
        expect(await listPermissions()).toHaveLength(1)
        expect(await listBlockers()).toHaveLength(1)

        await run(Session.Service.use((svc) => svc.remove(session.id)))

        await expect(question.promise).rejects.toThrow("Question cancelled before the user answered it.")
        await expect(permission.promise).rejects.toThrow("The user rejected permission to use this specific tool call.")
        expect(await listQuestions()).toEqual([])
        expect(await listPermissions()).toEqual([])
        expect(await listBlockers()).toEqual([])
      },
    })
  })

  test("archiving a session terminates question, permission, and blocker state", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await run(Session.Service.use((svc) => svc.create({})))
        const question = await createPendingQuestion(session.id)
        const permission = await createPendingPermission(session.id)

        await run(Session.Service.use((svc) => svc.setArchived({ sessionID: session.id, time: Date.now() })))

        await expect(question.promise).rejects.toThrow("Question cancelled before the user answered it.")
        await expect(permission.promise).rejects.toThrow("The user rejected permission to use this specific tool call.")
        expect(await listQuestions()).toEqual([])
        expect(await listPermissions()).toEqual([])
        expect(await listBlockers()).toEqual([])
      },
    })
  })
})
