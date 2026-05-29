import z from "zod"
import type { PtyID } from "./schema"

const DEFAULT_TTL_MS = 60_000

export const ConnectToken = z
  .object({
    ticket: z.string(),
    expires_in: z.number().int().positive(),
  })
  .meta({ ref: "PtyConnectToken" })

export type ConnectToken = z.infer<typeof ConnectToken>

type TicketRecord = {
  ptyID: PtyID
  expiresAt: number
}

type StoreOptions = {
  ttlMs?: number
  now?: () => number
  random?: () => string
}

export class PtyTicketStore {
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly random: () => string
  private readonly tickets = new Map<string, TicketRecord>()

  constructor(options: StoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.now = options.now ?? Date.now
    this.random = options.random ?? (() => crypto.randomUUID())
  }

  issue(input: { ptyID: PtyID }): ConnectToken {
    const ticket = this.random()
    this.tickets.set(ticket, {
      ptyID: input.ptyID,
      expiresAt: this.now() + this.ttlMs,
    })
    return {
      ticket,
      expires_in: Math.max(1, Math.round(this.ttlMs / 1000)),
    }
  }

  consume(input: { ptyID: PtyID; ticket: string }) {
    const record = this.tickets.get(input.ticket)
    if (!record) return false
    if (record.expiresAt <= this.now()) {
      this.tickets.delete(input.ticket)
      return false
    }
    if (record.ptyID !== input.ptyID) return false
    this.tickets.delete(input.ticket)
    return true
  }
}

export const PtyTicket = new PtyTicketStore()
