import { test, expect } from "bun:test"
import { dispatchEvent, type EventHandler, parseSSE, ReplayRefreshError } from "./pawwork-events.ts"
import type {
  PendingPermission,
  PendingQuestion,
  PermissionResolution,
  QuestionResolution,
  Session,
} from "./types.ts"

function recorder() {
  const calls = {
    texts: [] as { sessionID: string; text: string }[],
    permissions: [] as PendingPermission[],
    resolvedPermissions: [] as PermissionResolution[],
    questions: [] as PendingQuestion[],
    resolvedQuestions: [] as QuestionResolution[],
    sessions: [] as Session[],
  }
  const handler: EventHandler = {
    async handleAssistantText(sessionID, text) {
      calls.texts.push({ sessionID, text })
    },
    async handlePermission(permission) {
      calls.permissions.push(permission)
    },
    async handlePermissionResolved(resolution) {
      calls.resolvedPermissions.push(resolution)
    },
    async handleQuestion(question) {
      calls.questions.push(question)
    },
    async handleQuestionResolved(resolution) {
      calls.resolvedQuestions.push(resolution)
    },
    async handleSession(session) {
      calls.sessions.push(session)
    },
  }
  return { handler, calls }
}

test("routes a completed assistant text part", async () => {
  const { handler, calls } = recorder()
  await dispatchEvent(
    {
      payload: {
        type: "message.part.updated",
        properties: { part: { type: "text", sessionID: "ses_1", messageID: "msg_1", id: "prt_1", text: "hello", time: { start: 1, end: 2 } } },
      },
    },
    handler,
  )
  expect(calls.texts).toEqual([{ sessionID: "ses_1", text: "hello" }])
})

test("ignores streaming deltas and reasoning parts", async () => {
  const { handler, calls } = recorder()
  await dispatchEvent({ payload: { type: "message.part.delta", properties: { sessionID: "ses_1", delta: " hello" } } }, handler)
  await dispatchEvent(
    { payload: { type: "message.part.updated", properties: { part: { type: "reasoning", sessionID: "ses_1", text: "private", time: { end: 2 } } } } },
    handler,
  )
  expect(calls.texts).toEqual([])
})

test("routes a pending permission and a ready question", async () => {
  const { handler, calls } = recorder()
  await dispatchEvent(
    { directory: "/repo/a", payload: { type: "permission.asked", properties: { id: "perm_1", sessionID: "ses_1", permission: "edit", patterns: ["/repo/app.ts"] } } },
    handler,
  )
  expect(calls.permissions).toHaveLength(1)
  expect(calls.permissions[0].id).toBe("perm_1")
  expect(calls.permissions[0].directory).toBe("/repo/a")

  await dispatchEvent(
    {
      directory: "/repo/a",
      payload: {
        type: "message.part.updated",
        properties: {
          part: {
            type: "tool",
            sessionID: "ses_1",
            messageID: "msg_1",
            callID: "call_1",
            tool: "question",
            state: {
              status: "running",
              metadata: { externalResultReady: true },
              input: { questions: [{ header: "Approach", question: "Pick one", multiple: false, options: [{ label: "A", description: "Small" }, { label: "B", description: "Large" }] }] },
            },
          },
        },
      },
    },
    handler,
  )
  expect(calls.questions).toHaveLength(1)
  const q = calls.questions[0]
  expect([q.sessionID, q.messageID, q.callID]).toEqual(["ses_1", "msg_1", "call_1"])
  expect(q.directory).toBe("/repo/a")
  expect(q.questions[0].options[1].label).toBe("B")
})

test("routes a resolved permission and a resolved question", async () => {
  const { handler, calls } = recorder()
  await dispatchEvent(
    { directory: "/repo/a", payload: { type: "permission.replied", properties: { sessionID: "ses_1", requestID: "perm_1", reply: "once" } } },
    handler,
  )
  expect(calls.resolvedPermissions).toEqual([{ sessionID: "ses_1", requestID: "perm_1", directory: "/repo/a" }])

  await dispatchEvent(
    { directory: "/repo/a", payload: { type: "message.part.updated", properties: { part: { type: "tool", sessionID: "ses_1", messageID: "msg_1", callID: "call_1", tool: "question", state: { status: "completed" } } } } },
    handler,
  )
  expect(calls.resolvedQuestions).toEqual([{ sessionID: "ses_1", messageID: "msg_1", callID: "call_1", directory: "/repo/a" }])
})

test("routes session.created with parent and directory", async () => {
  const { handler, calls } = recorder()
  await dispatchEvent(
    { directory: "/repo/a", payload: { type: "session.created", properties: { sessionID: "child_1", info: { id: "child_1", title: "Child session", parentID: "root_1" } } } },
    handler,
  )
  expect(calls.sessions).toEqual([{ id: "child_1", title: "Child session", parentID: "root_1", directory: "/repo/a" }])
})

test("ignores a question before externalResultReady", async () => {
  const { handler, calls } = recorder()
  await dispatchEvent(
    { payload: { type: "message.part.updated", properties: { part: { type: "tool", sessionID: "ses_1", messageID: "msg_1", callID: "call_1", tool: "question", state: { status: "pending", input: { questions: [{ question: "Pick one" }] } } } } } },
    handler,
  )
  expect(calls.questions).toEqual([])
})

test("reconciles a ready question whose questions field is the wrong type", async () => {
  const { handler, calls } = recorder()
  // A wrong-typed `questions` (string, not array) is undecodable — surface a
  // repairable error so the caller reconciles, never an empty-question prompt.
  await expect(
    dispatchEvent(
      { payload: { type: "message.part.updated", properties: { part: { type: "tool", sessionID: "ses_1", messageID: "msg_1", callID: "call_1", tool: "question", state: { status: "running", metadata: { externalResultReady: true }, input: { questions: "Pick one" } } } } } },
      handler,
    ),
  ).rejects.toThrow()
  expect(calls.questions).toEqual([])
})

test("reconciles a permission whose patterns contain a non-string element", async () => {
  const { handler, calls } = recorder()
  // Go's []string unmarshal rejects [123]; coercing it would crash prompt
  // rendering on .trim(). Surface it as repairable so the caller reconciles.
  await expect(
    dispatchEvent(
      { payload: { type: "permission.asked", properties: { id: "perm_1", sessionID: "ses_1", permission: "edit", patterns: [123] } } },
      handler,
    ),
  ).rejects.toThrow()
  expect(calls.permissions).toEqual([])
})

test("reconciles a ready question whose nested field is the wrong type", async () => {
  const { handler, calls } = recorder()
  // A non-string header is undecodable for Go's []bridge.Question unmarshal.
  await expect(
    dispatchEvent(
      { payload: { type: "message.part.updated", properties: { part: { type: "tool", sessionID: "ses_1", messageID: "msg_1", callID: "call_1", tool: "question", state: { status: "running", metadata: { externalResultReady: true }, input: { questions: [{ header: 1, question: "Pick one", options: [] }] } } } } } },
      handler,
    ),
  ).rejects.toThrow()
  expect(calls.questions).toEqual([])
})

test("reconciles a ready question whose multiple flag is not a boolean", async () => {
  const { handler, calls } = recorder()
  // Boolean("false") would be true; Go's `Multiple bool` unmarshal rejects it, so
  // reconcile rather than silently flip a single-select question to multi-select.
  await expect(
    dispatchEvent(
      { payload: { type: "message.part.updated", properties: { part: { type: "tool", sessionID: "ses_1", messageID: "msg_1", callID: "call_1", tool: "question", state: { status: "running", metadata: { externalResultReady: true }, input: { questions: [{ question: "Pick", multiple: "false", options: [] }] } } } } } },
      handler,
    ),
  ).rejects.toThrow()
  expect(calls.questions).toEqual([])
})

test("cancels the stream reader when an event handler throws", async () => {
  // A thrown dispatch/reconcile error must abandon the connection (Go's deferred
  // Body.Close), not just release the lock, so the stream cannot leak on error.
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"payload":{"type":"server.connected","properties":{}}}\n\n'))
    },
    cancel() {
      cancelled = true
    },
  })
  const { handler } = recorder()
  handler.handleReplayRefresh = async () => {
    throw new ReplayRefreshError(new Error("hydrate failed"))
  }
  await expect(parseSSE(stream, handler, async () => {})).rejects.toThrow()
  expect(cancelled).toBe(true)
})
