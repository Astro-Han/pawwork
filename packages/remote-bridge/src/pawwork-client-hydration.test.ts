import { expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HTTPStatusError, PawWorkClient } from "./pawwork-client.ts"
import type { EventHandler } from "./pawwork-events.ts"
import { SessionPointers } from "./session-pointers.ts"

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })

function recorder() {
  const texts: { sessionID: string; text: string }[] = []
  const handler: EventHandler = {
    async handleAssistantText(sessionID, text) {
      texts.push({ sessionID, text })
    },
    async handlePermission() {},
    async handlePermissionResolved() {},
    async handleQuestion() {},
    async handleQuestionResolved() {},
    async handleSession() {},
  }
  return { handler, texts }
}

test("replyPermission and submitQuestion post the expected bodies and directory", async () => {
  let permissionBody: any
  let questionBody: any
  let permissionDirectory: string | null = null
  let questionDirectory: string | null = null
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const body = await req.json().catch(() => undefined)
      if (url.pathname === "/permission/perm_1/reply") {
        permissionDirectory = req.headers.get("x-opencode-directory")
        permissionBody = body
        return json(true)
      }
      if (url.pathname === "/session/ses_1/tool/respond") {
        questionDirectory = req.headers.get("x-opencode-directory")
        questionBody = body
        return json({ status: "ok" })
      }
      return json(null)
    },
  })
  try {
    const client = new PawWorkClient({ baseURL: `http://localhost:${server.port}` })
    await client.replyPermission(
      { id: "perm_1", sessionID: "ses_1", permission: "", patterns: [], directory: "/repo/interactions" },
      { reply: "once", message: "go" },
    )
    expect(permissionBody).toEqual({ reply: "once", message: "go" })
    expect(permissionDirectory).toBe("/repo/interactions")

    await client.submitQuestion(
      { sessionID: "ses_1", messageID: "msg_1", callID: "call_1", questions: [], directory: "/repo/interactions" },
      [["A"]],
    )
    expect(questionBody.kind).toBe("submit")
    expect(questionBody.messageID).toBe("msg_1")
    expect(questionBody.callID).toBe("call_1")
    expect(questionBody.payload).toEqual({ answers: [["A"]] })
    expect(questionDirectory).toBe("/repo/interactions")
  } finally {
    server.stop(true)
  }
})

test("listPermissions and listQuestions map fields and reuse the session directory", async () => {
  const permissionDirectories: (string | null)[] = []
  const questionDirectories: (string | null)[] = []
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/experimental/session") return json([{ id: "ses_1", directory: "/repo/a" }])
      if (url.pathname === "/permission") {
        permissionDirectories.push(req.headers.get("x-opencode-directory"))
        return json([{ id: "perm_1", sessionID: "ses_1", permission: "edit", patterns: ["/repo/app.ts"] }])
      }
      if (url.pathname === "/external-result") {
        questionDirectories.push(req.headers.get("x-opencode-directory"))
        return json([
          {
            part: {
              type: "tool",
              sessionID: "ses_1",
              messageID: "msg_1",
              callID: "call_1",
              tool: "question",
              state: {
                status: "running",
                metadata: { externalResultReady: true },
                input: {
                  questions: [
                    {
                      header: "Approach",
                      question: "Pick one",
                      options: [
                        { label: "A", description: "Small" },
                        { label: "B", description: "Large" },
                      ],
                    },
                  ],
                },
              },
            },
          },
        ])
      }
      return json(null)
    },
  })
  try {
    const client = new PawWorkClient({ baseURL: `http://localhost:${server.port}` })
    await client.listSessions(5) // remembers ses_1 → /repo/a
    const permissions = await client.listPermissions()
    expect(permissions).toEqual([
      { id: "perm_1", sessionID: "ses_1", permission: "edit", patterns: ["/repo/app.ts"], directory: "/repo/a" },
    ])
    expect(permissionDirectories).toEqual(["/repo/a"])

    const questions = await client.listQuestions()
    expect(questions).toHaveLength(1)
    expect(questions[0].callID).toBe("call_1")
    expect(questions[0].questions[0].options[1].label).toBe("B")
    expect(questions[0].directory).toBe("/repo/a")
    expect(questionDirectories).toEqual(["/repo/a"])
  } finally {
    server.stop(true)
  }
})

test("listPermissions surfaces a fatal directory status instead of skipping it", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/experimental/session") return json([{ id: "ses_a", directory: "/repo/a" }])
      if (url.pathname === "/permission") return new Response("forbidden", { status: 403 })
      return json(null)
    },
  })
  try {
    const client = new PawWorkClient({ baseURL: `http://localhost:${server.port}` })
    await client.listSessions(5)
    let caught: unknown
    await client.listPermissions().catch((err) => (caught = err))
    expect(caught).toBeInstanceOf(HTTPStatusError)
    expect((caught as HTTPStatusError).statusCode).toBe(403)
  } finally {
    server.stop(true)
  }
})

test("listPermissions surfaces malformed JSON rather than dropping pending state", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/experimental/session") return json([{ id: "ses_a", directory: "/repo/a" }])
      if (url.pathname === "/permission")
        return new Response("{not json", { headers: { "content-type": "application/json" } })
      return json(null)
    },
  })
  try {
    const client = new PawWorkClient({ baseURL: `http://localhost:${server.port}` })
    await client.listSessions(5)
    // A malformed 2xx body is a protocol error, not a transient blip — surface it.
    await expect(client.listPermissions()).rejects.toThrow()
  } finally {
    server.stop(true)
  }
})

test("listPermissions surfaces a cancelled caller signal, not partial success", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/experimental/session") return json([{ id: "ses_a", directory: "/repo/a" }])
      return json(null)
    },
  })
  try {
    const client = new PawWorkClient({ baseURL: `http://localhost:${server.port}` })
    await client.listSessions(5)
    const controller = new AbortController()
    controller.abort()
    await expect(client.listPermissions(controller.signal)).rejects.toThrow()
  } finally {
    server.stop(true)
  }
})

test("persists the Last-Event-ID cursor across restarts", async () => {
  const statePath = join(await mkdtemp(join(tmpdir(), "rb-cursor-")), "sessions.json")
  let requests = 0
  const seen: (string | null)[] = []
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      requests++
      seen.push(req.headers.get("Last-Event-ID"))
      const sse = (body: string) => new Response(body, { headers: { "content-type": "text/event-stream" } })
      if (requests === 1) return sse('id: cursor-1\ndata: {"payload":{"type":"server.connected","properties":{}}}\n\n')
      if (requests === 2)
        return sse(
          'id: cursor-2\ndata: {"payload":{"type":"message.part.updated","properties":{"part":{"type":"text","sessionID":"ses_1","text":"done","time":{"end":2}}}}}\n\n',
        )
      return sse('id: cursor-3\ndata: {"payload":{"type":"server.connected","properties":{}}}\n\n')
    },
  })
  try {
    const baseURL = `http://localhost:${server.port}`

    const first = new PawWorkClient({ baseURL })
    first.setEventCursorStore(await SessionPointers.fromFile(statePath))
    await first.streamEvents(recorder().handler)

    const second = new PawWorkClient({ baseURL })
    second.setEventCursorStore(await SessionPointers.fromFile(statePath))
    const secondRec = recorder()
    await second.streamEvents(secondRec.handler)
    expect(secondRec.texts).toEqual([{ sessionID: "ses_1", text: "done" }])

    const third = new PawWorkClient({ baseURL })
    third.setEventCursorStore(await SessionPointers.fromFile(statePath))
    const thirdRec = recorder()
    await third.streamEvents(thirdRec.handler)
    expect(thirdRec.texts).toHaveLength(0)

    expect(seen).toEqual([null, "cursor-1", "cursor-2"])
  } finally {
    server.stop(true)
  }
})
