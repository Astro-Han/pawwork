import { test, expect } from "bun:test"
import { PawWorkClient } from "./pawwork-client.ts"

interface Captured {
  method: string
  path: string
  directory: string | null
  auth: string | null
  body: any
}

function mockServer(routes: (req: { method: string; path: string; body: any }) => Response | undefined) {
  const seen: Captured[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const text = await req.text()
      const body = text === "" ? undefined : JSON.parse(text)
      seen.push({
        method: req.method,
        path: url.pathname + url.search,
        directory: req.headers.get("x-opencode-directory"),
        auth: req.headers.get("authorization"),
        body,
      })
      return routes({ method: req.method, path: url.pathname, body }) ?? new Response("null", { headers: { "content-type": "application/json" } })
    },
  })
  return { url: `http://localhost:${server.port}`, seen, stop: () => server.stop(true) }
}

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } })

test("createSession posts /session with auth + directory and remembers the session directory", async () => {
  const server = mockServer(({ method, path }) => {
    if (method === "POST" && path === "/session") return json({ id: "ses_1", directory: "/repo/a" })
    return undefined
  })
  try {
    const client = new PawWorkClient({ baseURL: server.url, username: "me", password: "pw", directory: "/repo/a" })
    const id = await client.createSession()
    expect(id).toBe("ses_1")
    // A later prompt reuses the remembered directory — no extra GET /session/{id}.
    await client.sendPrompt("ses_1", "hello")
    const prompt = server.seen.find((r) => r.path === "/session/ses_1/prompt_async")
    expect(prompt?.directory).toBe("/repo/a")
    expect(prompt?.body).toEqual({ parts: [{ type: "text", text: "hello" }] })
    expect(server.seen.every((r) => r.auth?.startsWith("Basic "))).toBe(true)
    expect(server.seen.some((r) => r.path === "/session/ses_1")).toBe(false)
  } finally {
    server.stop()
  }
})

test("listSessions encodes directory + limit and maps fields", async () => {
  const server = mockServer(({ method, path }) => {
    if (method === "GET" && path === "/experimental/session") {
      return json([{ id: "ses_1", title: "T", parentID: "root", directory: "/repo/b" }])
    }
    return undefined
  })
  try {
    const client = new PawWorkClient({ baseURL: server.url, directory: "/repo/a" })
    const sessions = await client.listSessions(10)
    expect(sessions).toEqual([{ id: "ses_1", title: "T", parentID: "root", directory: "/repo/b" }])
    const req = server.seen[0]
    expect(req.path).toContain("directory=%2Frepo%2Fa")
    expect(req.path).toContain("sort=updated")
    expect(req.path).toContain("limit=10")
  } finally {
    server.stop()
  }
})

test("replyPermission resolves the directory from the session when absent", async () => {
  const server = mockServer(({ method, path }) => {
    if (method === "GET" && path === "/session/ses_1") return json({ id: "ses_1", directory: "/repo/c" })
    if (method === "POST" && path === "/permission/perm_1/reply") return json(null)
    return undefined
  })
  try {
    const client = new PawWorkClient({ baseURL: server.url })
    await client.replyPermission(
      { id: "perm_1", sessionID: "ses_1", permission: "edit", patterns: [], directory: "" },
      { reply: "once", message: "" },
    )
    const reply = server.seen.find((r) => r.path === "/permission/perm_1/reply")
    expect(reply?.directory).toBe("/repo/c")
    expect(reply?.body).toEqual({ reply: "once" }) // empty message omitted
  } finally {
    server.stop()
  }
})

test("listPermissions skips a directory on a transient 5xx and surfaces the rest", async () => {
  // default dir /repo/a → 500 (transient, skipped); the remembered /repo/b → ok.
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      const dir = req.headers.get("x-opencode-directory")
      if (url.pathname === "/experimental/session") return json([{ id: "ses_x", directory: "/repo/b" }])
      if (url.pathname === "/permission") {
        if (dir === "/repo/a") return new Response("boom", { status: 500 })
        return json([{ id: "perm_9", sessionID: "ses_x", permission: "edit", patterns: ["x"] }])
      }
      return json(null)
    },
  })
  try {
    const client = new PawWorkClient({ baseURL: `http://localhost:${server.port}`, directory: "/repo/a" })
    await client.listSessions(5) // remembers /repo/b
    const perms = await client.listPermissions()
    expect(perms).toEqual([{ id: "perm_9", sessionID: "ses_x", permission: "edit", patterns: ["x"], directory: "/repo/b" }])
  } finally {
    server.stop(true)
  }
})
