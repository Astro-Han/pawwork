import { afterEach, describe, expect, test } from "bun:test"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { Permission } from "../../src/permission"
import { Question } from "../../src/question"
import { QuestionID } from "../../src/question/schema"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { MessageID, SessionID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"
import type { Effect } from "effect"

afterEach(async () => {
  await Instance.disposeAll()
})

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => AppRuntime.runPromise(effect as never) as Promise<A>

async function askQuestion(sessionID: SessionID, suffix: string) {
  const promise = run(
    Question.Service.use((svc) =>
      svc.ask({
        sessionID,
        questions: [
          {
            question: `Question ${suffix}?`,
            header: suffix,
            options: [
              { label: "Yes", description: "yes" },
              { label: "No", description: "no" },
            ],
          },
        ],
        tool: { messageID: MessageID.make(`msg_${suffix}`), callID: `call_${suffix}` },
      }),
    ),
  )
  await waitFor(async () => (await listQuestions()).some((item) => item.sessionID === sessionID))
  return { promise }
}

async function askPermission(sessionID: SessionID) {
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
  await waitFor(async () => (await listPermissions()).some((item) => item.sessionID === sessionID))
  return { promise }
}

const listQuestions = () => run(Question.Service.use((svc) => svc.list()))
const listPermissions = () => run(Permission.Service.use((svc) => svc.list()))

async function rejectAllQuestions() {
  for (const request of await listQuestions()) {
    await run(Question.Service.use((svc) => svc.reject(request.id)))
  }
}

async function rejectAllPermissions() {
  for (const request of await listPermissions()) {
    await run(Permission.Service.use((svc) => svc.reply({ requestID: request.id, reply: "reject" })))
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 1000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error("timed out waiting for condition")
}

describe("pending interaction routes", () => {
  test("question, permission, and blocker list routes prune missing-session entries", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const instanceQuery = `?directory=${encodeURIComponent(tmp.path)}`
        const session = await run(Session.Service.use((svc) => svc.create({})))
        const missingSessionID = SessionID.make("ses_missing_pending_route")
        const missingQuestion = await askQuestion(missingSessionID, "missing")
        const validQuestion = await askQuestion(session.id, "valid")
        const missingPermission = await askPermission(missingSessionID)
        const validPermission = await askPermission(session.id)

        try {
          const questionRes = await app.request(`/question${instanceQuery}`)
          expect(questionRes.status).toBe(200)
          const questions = (await questionRes.json()) as Array<{ id: QuestionID; sessionID: SessionID }>
          expect(questions.map((item) => item.sessionID)).toEqual([session.id])

          const permissionRes = await app.request(`/permission${instanceQuery}`)
          expect(permissionRes.status).toBe(200)
          const permissions = (await permissionRes.json()) as Array<{ sessionID: SessionID }>
          expect(permissions.map((item) => item.sessionID)).toEqual([session.id])

          const blockerRes = await app.request(`/blocker${instanceQuery}`)
          expect(blockerRes.status).toBe(200)
          const blockers = (await blockerRes.json()) as Array<{ sessionID: SessionID }>
          expect(blockers.map((item) => item.sessionID)).toEqual([session.id])

          await expect(missingQuestion.promise).rejects.toThrow("Question cancelled before the user answered it.")
          await expect(missingPermission.promise).rejects.toThrow(
            "The user rejected permission to use this specific tool call.",
          )
        } finally {
          await rejectAllQuestions()
          await rejectAllPermissions()
          await Promise.all([
            missingQuestion.promise.catch(() => {}),
            validQuestion.promise.catch(() => {}),
            missingPermission.promise.catch(() => {}),
            validPermission.promise.catch(() => {}),
          ])
        }
      },
    })
  })
})
