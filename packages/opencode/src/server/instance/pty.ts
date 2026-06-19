import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import { HTTPException } from "hono/http-exception"
import type { UpgradeWebSocket, WSEvents } from "hono/ws"
import z from "zod"
import { Effect } from "effect"
import { AppRuntime } from "@/effect/app-runtime"
import { Pty } from "@/pty"
import { PtyID } from "@/pty/schema"
import { ConnectToken, PtyTicket } from "@/pty/ticket"
import { NotFoundError } from "../../storage/db"
import { errors } from "../error"

export function assertPtyConnectTarget(info: unknown) {
  if (!info) {
    throw new NotFoundError({ message: "PTY session not found" })
  }
}

function assertPtyConnectTicket(input: { ptyID: PtyID; ticket?: string }) {
  if (!input.ticket) return
  if (PtyTicket.consume({ ptyID: input.ptyID, ticket: input.ticket })) return
  throw new HTTPException(401, { message: "Invalid PTY connect ticket" })
}

const PtyConnectQuery = z.object({ cursor: z.string().optional(), ticket: z.string().optional() })
type PtyConnectQuery = z.infer<typeof PtyConnectQuery>
type PtyConnectRequest = {
  valid(target: "param"): { ptyID: PtyID }
  valid(target: "query"): PtyConnectQuery
}

type PtyConnectHandler = {
  onMessage: (message: string | ArrayBuffer) => void
  onClose: () => void
}

type PtyConnectSocket = {
  readyState: number
  send: (data: string | Uint8Array | ArrayBuffer) => void
  close: (code?: number, reason?: string) => void
}

const isPtyConnectSocket = (value: unknown): value is PtyConnectSocket => {
  if (!value || typeof value !== "object") return false
  if (!("readyState" in value)) return false
  if (!("send" in value) || typeof (value as { send?: unknown }).send !== "function") return false
  if (!("close" in value) || typeof (value as { close?: unknown }).close !== "function") return false
  return typeof (value as { readyState?: unknown }).readyState === "number"
}

const runPtyRoute: typeof AppRuntime.runPromise = (effect, options) => AppRuntime.runPromise(effect, options)

const listPtySessions = Effect.fn("PtyRoutes.list")(function* () {
  const pty = yield* Pty.Service
  return yield* pty.list()
})

const createPtySession = Effect.fn("PtyRoutes.create")(function* (input: Pty.CreateInput) {
  const pty = yield* Pty.Service
  return yield* pty.create(input)
})

const getPtySession = Effect.fn("PtyRoutes.get")(function* (id: PtyID) {
  const pty = yield* Pty.Service
  return yield* pty.get(id)
})

const updatePtySession = Effect.fn("PtyRoutes.update")(function* (input: { id: PtyID; update: Pty.UpdateInput }) {
  const pty = yield* Pty.Service
  return yield* pty.update(input.id, input.update)
})

const removePtySession = Effect.fn("PtyRoutes.remove")(function* (id: PtyID) {
  const pty = yield* Pty.Service
  const info = yield* pty.get(id)
  if (!info) return false
  yield* pty.remove(id)
  return true
})

const assertPtyConnectTokenTarget = Effect.fn("PtyRoutes.connectToken")(function* (id: PtyID) {
  const pty = yield* Pty.Service
  assertPtyConnectTarget(yield* pty.get(id))
})

const connectPtySession = Effect.fn("PtyRoutes.connect")(function* (request: PtyConnectRequest) {
  const pty = yield* Pty.Service
  const id = request.valid("param").ptyID
  const query = request.valid("query")
  assertPtyConnectTicket({ ptyID: id, ticket: query.ticket })
  const cursor = (() => {
    const value = query.cursor
    if (!value) return
    const parsed = Number(value)
    if (!Number.isSafeInteger(parsed) || parsed < -1) return
    return parsed
  })()
  let handler: PtyConnectHandler | undefined
  assertPtyConnectTarget(yield* pty.get(id))

  const pending: string[] = []
  let ready = false

  return {
    async onOpen(_event, ws) {
      const socket = ws.raw
      if (!isPtyConnectSocket(socket)) {
        ws.close()
        return
      }
      handler = await AppRuntime.runPromise(pty.connect(id, socket, cursor))
      ready = true
      for (const msg of pending) handler?.onMessage(msg)
      pending.length = 0
    },
    onMessage(event) {
      if (typeof event.data !== "string") return
      if (!ready) {
        pending.push(event.data)
        return
      }
      handler?.onMessage(event.data)
    },
    onClose() {
      handler?.onClose()
    },
    onError() {
      handler?.onClose()
    },
  } satisfies WSEvents
})

export function PtyRoutes(upgradeWebSocket: UpgradeWebSocket) {
  return new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List PTY sessions",
        description: "Get a list of all active pseudo-terminal (PTY) sessions managed by OpenCode.",
        operationId: "pty.list",
        responses: {
          200: {
            description: "List of sessions",
            content: {
              "application/json": {
                schema: resolver(Pty.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const sessions = await runPtyRoute(listPtySessions())
        return c.json(sessions)
      },
    )
    .post(
      "/",
      describeRoute({
        summary: "Create PTY session",
        description: "Create a new pseudo-terminal (PTY) session for running shell commands and processes.",
        operationId: "pty.create",
        responses: {
          200: {
            description: "Created session",
            content: {
              "application/json": {
                schema: resolver(Pty.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Pty.CreateInput),
      async (c) => {
        const input = c.req.valid("json")
        const info = await runPtyRoute(createPtySession(input))
        return c.json(info)
      },
    )
    .get(
      "/:ptyID",
      describeRoute({
        summary: "Get PTY session",
        description: "Retrieve detailed information about a specific pseudo-terminal (PTY) session.",
        operationId: "pty.get",
        responses: {
          200: {
            description: "Session info",
            content: {
              "application/json": {
                schema: resolver(Pty.Info),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ ptyID: PtyID.zod })),
      async (c) => {
        const id = c.req.valid("param").ptyID
        const info = await runPtyRoute(getPtySession(id))
        if (!info) {
          throw new NotFoundError({ message: "Session not found" })
        }
        return c.json(info)
      },
    )
    .put(
      "/:ptyID",
      describeRoute({
        summary: "Update PTY session",
        description: "Update properties of an existing pseudo-terminal (PTY) session.",
        operationId: "pty.update",
        responses: {
          200: {
            description: "Updated session",
            content: {
              "application/json": {
                schema: resolver(Pty.Info),
              },
            },
          },
          ...errors(400),
          ...errors(404),
        },
      }),
      validator("param", z.object({ ptyID: PtyID.zod })),
      validator("json", Pty.UpdateInput),
      async (c) => {
        const id = c.req.valid("param").ptyID
        const input = c.req.valid("json")
        const info = await runPtyRoute(updatePtySession({ id, update: input }))
        if (!info) {
          throw new NotFoundError({ message: "Session not found" })
        }
        return c.json(info)
      },
    )
    .delete(
      "/:ptyID",
      describeRoute({
        summary: "Remove PTY session",
        description: "Remove and terminate a specific pseudo-terminal (PTY) session.",
        operationId: "pty.remove",
        responses: {
          200: {
            description: "Session removed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ ptyID: PtyID.zod })),
      async (c) => {
        const id = c.req.valid("param").ptyID
        const removed = await runPtyRoute(removePtySession(id))
        if (!removed) {
          throw new NotFoundError({ message: "Session not found" })
        }
        return c.json(true)
      },
    )
    .post(
      "/:ptyID/connect-token",
      describeRoute({
        summary: "Create PTY WebSocket token",
        description: "Create a short-lived ticket for opening a PTY WebSocket connection.",
        operationId: "pty.connectToken",
        responses: {
          200: {
            description: "WebSocket connect token",
            content: {
              "application/json": {
                schema: resolver(ConnectToken),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ ptyID: PtyID.zod })),
      async (c) => {
        const id = c.req.valid("param").ptyID
        await runPtyRoute(assertPtyConnectTokenTarget(id))
        return c.json(PtyTicket.issue({ ptyID: id }))
      },
    )
    .get(
      "/:ptyID/connect",
      describeRoute({
        summary: "Connect to PTY session",
        description: "Establish a WebSocket connection to interact with a pseudo-terminal (PTY) session in real-time.",
        operationId: "pty.connect",
        responses: {
          200: {
            description: "Connected session",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ ptyID: PtyID.zod })),
      validator("query", PtyConnectQuery),
      upgradeWebSocket(async (c) => {
        const request = c.req as unknown as PtyConnectRequest
        return runPtyRoute(connectPtySession(request))
      }),
    )
}

export function PtyConnectCompatibilityRoutes(upgradeWebSocket: UpgradeWebSocket) {
  return new Hono().get(
    "/:ptyID/connect",
    describeRoute({
      summary: "Connect to PTY session",
      description: "Establish a WebSocket connection to interact with a pseudo-terminal (PTY) session in real-time.",
      operationId: "pty.connect",
      responses: {
        200: {
          description: "Connected session",
          content: {
            "application/json": {
              schema: resolver(z.boolean()),
            },
          },
        },
        ...errors(404),
      },
    }),
    validator("param", z.object({ ptyID: PtyID.zod })),
    validator("query", PtyConnectQuery),
    upgradeWebSocket(async (c) => {
      const request = c.req as unknown as PtyConnectRequest
      return runPtyRoute(connectPtySession(request))
    }),
  )
}
