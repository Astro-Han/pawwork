import { HTTPException } from "hono/http-exception"
import z from "zod"
import { Effect } from "effect"
import { AppRuntime } from "@/effect/app-runtime"
import { Pty } from "@/pty"
import { PtyID } from "@/pty/schema"
import { PtyTicket } from "@/pty/ticket"
import { NotFoundError } from "../../storage/db"
import type { WebSocketEvents } from "../adapter"

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
const PtyConnectParam = z.object({ ptyID: PtyID.zod })
type PtyConnectInput = PtyConnectQuery & {
  ptyID: PtyID
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

function badRequest(data: unknown, error: z.ZodIssue[]) {
  return Response.json({ data, error, success: false }, { status: 400 })
}

function parsePtyConnectInput(request: Request, rawPtyID: string) {
  const params = { ptyID: rawPtyID }
  const parsedParams = PtyConnectParam.safeParse(params)
  if (!parsedParams.success) return badRequest(params, parsedParams.error.issues)

  const url = new URL(request.url)
  const query = {
    cursor: url.searchParams.get("cursor") ?? undefined,
    ticket: url.searchParams.get("ticket") ?? undefined,
  }
  const parsedQuery = PtyConnectQuery.safeParse(query)
  if (!parsedQuery.success) return badRequest(query, parsedQuery.error.issues)

  return {
    ptyID: parsedParams.data.ptyID,
    ...parsedQuery.data,
  } satisfies PtyConnectInput
}

const connectPtySession = Effect.fn("PtyWebSocket.connect")(function* (input: PtyConnectInput) {
  const pty = yield* Pty.Service
  const id = input.ptyID
  assertPtyConnectTicket({ ptyID: id, ticket: input.ticket })
  const cursor = (() => {
    const value = input.cursor
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
  } satisfies WebSocketEvents
})

export async function createPtyConnectEvents(request: Request, rawPtyID: string) {
  const input = parsePtyConnectInput(request, rawPtyID)
  if (input instanceof Response) return input
  return runPtyRoute(connectPtySession(input))
}
