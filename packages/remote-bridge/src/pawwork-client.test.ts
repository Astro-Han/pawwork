import { test, expect } from "bun:test"
import { PawWorkClient, isFatalStreamError } from "./pawwork-client.ts"
import type { EventHandler } from "./pawwork-events.ts"

function sseServer(body: string, contentType = "text/event-stream") {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(body, { headers: { "content-type": contentType } })
    },
  })
  return { url: `http://localhost:${server.port}`, stop: () => server.stop(true) }
}

function recorder(opts: { textErr?: Error } = {}) {
  const calls = {
    texts: [] as { sessionID: string; text: string }[],
    permissions: [] as unknown[],
    questions: [] as unknown[],
    sessions: [] as unknown[],
    refreshes: 0,
    ready: 0,
  }
  const handler: EventHandler = {
    async handleAssistantText(sessionID, text) {
      calls.texts.push({ sessionID, text })
      if (opts.textErr) throw opts.textErr
    },
    async handlePermission(p) {
      calls.permissions.push(p)
    },
    async handlePermissionResolved() {},
    async handleQuestion(q) {
      calls.questions.push(q)
    },
    async handleQuestionResolved() {},
    async handleSession(s) {
      calls.sessions.push(s)
    },
    async handleReplayRefresh() {
      calls.refreshes++
    },
    async handleStreamReady() {
      calls.ready++
    },
  }
  return { handler, calls }
}

const textEvent = (text: string, end: number) =>
  `data: {"payload":{"type":"message.part.updated","properties":{"part":{"type":"text","sessionID":"ses_1","text":${JSON.stringify(text)},"time":{"end":${end}}}}}}\n\n`

test("streams global events", async () => {
  const server = sseServer(textEvent("hi", 2))
  try {
    const { handler, calls } = recorder()
    await new PawWorkClient({ baseURL: server.url }).streamEvents(handler)
    expect(calls.texts).toEqual([{ sessionID: "ses_1", text: "hi" }])
  } finally {
    server.stop()
  }
})

test("rejects a non-SSE event stream before ready, fatally", async () => {
  const server = sseServer(`{"ok":true}`, "application/json")
  try {
    const { handler, calls } = recorder()
    let caught: unknown
    await new PawWorkClient({ baseURL: server.url }).streamEvents(handler).catch((e) => (caught = e))
    expect(caught).toBeDefined()
    expect(isFatalStreamError(caught)).toBe(true)
    expect(calls.ready).toBe(0)
  } finally {
    server.stop()
  }
})

test("continues after an event handler error", async () => {
  const server = sseServer(textEvent("first", 1) + textEvent("second", 2))
  try {
    const { handler, calls } = recorder({ textErr: new Error("send failed") })
    await new PawWorkClient({ baseURL: server.url }).streamEvents(handler)
    expect(calls.texts).toHaveLength(2)
  } finally {
    server.stop()
  }
})

test("streams a long completed text part", async () => {
  const longText = "x".repeat(70 * 1024)
  const server = sseServer(textEvent(longText, 2))
  try {
    const { handler, calls } = recorder()
    await new PawWorkClient({ baseURL: server.url }).streamEvents(handler)
    expect(calls.texts).toHaveLength(1)
    expect(calls.texts[0].text).toBe(longText)
  } finally {
    server.stop()
  }
})

test("reconciles after an undecodable critical event, advancing the cursor", async () => {
  // patterns is a string, not an array: undecodable, must reconcile not surface.
  const server = sseServer(`id: evt-7\ndata: {"payload":{"type":"permission.asked","properties":{"id":"perm_1","sessionID":"ses_1","patterns":"oops"}}}\n\n`)
  try {
    const { handler, calls } = recorder()
    const client = new PawWorkClient({ baseURL: server.url })
    await client.streamEvents(handler)
    expect(calls.permissions).toHaveLength(0)
    expect(client.lastEventIDValue()).toBe("evt-7")
    expect(calls.refreshes).toBe(1)
  } finally {
    server.stop()
  }
})

test("reconciles after an incomplete critical event, advancing the cursor", async () => {
  const cases = [
    `{"payload":{"type":"permission.asked","properties":{"sessionID":"ses_1","permission":"edit"}}}`,
    `{"payload":{"type":"session.created","properties":{"info":{"title":"child"}}}}`,
    `{"payload":{"type":"message.part.updated","properties":{"part":{"type":"tool","tool":"question","state":{"status":"running","metadata":{"externalResultReady":true}}}}}}`,
  ]
  for (const data of cases) {
    const server = sseServer(`id: evt-9\ndata: ${data}\n\n`)
    try {
      const { handler, calls } = recorder()
      const client = new PawWorkClient({ baseURL: server.url })
      await client.streamEvents(handler)
      expect(calls.permissions.length + calls.sessions.length + calls.questions.length).toBe(0)
      expect(client.lastEventIDValue()).toBe("evt-9")
      expect(calls.refreshes).toBe(1)
    } finally {
      server.stop()
    }
  }
})
