import { describe, expect, test } from "bun:test"
import { PtyTicketStore } from "../../src/pty/ticket"
import { PtyID } from "../../src/pty/schema"

describe("PtyTicketStore", () => {
  test("issues one-use tickets scoped to a PTY id", () => {
    const store = new PtyTicketStore({ ttlMs: 60_000, now: () => 1_000, random: () => "ticket-1" })
    const ptyID = PtyID.ascending()
    const otherPtyID = PtyID.ascending()

    const issued = store.issue({ ptyID })

    expect(issued).toEqual({ ticket: "ticket-1", expires_in: 60 })
    expect(store.consume({ ptyID: otherPtyID, ticket: issued.ticket })).toBe(false)
    expect(store.consume({ ptyID, ticket: issued.ticket })).toBe(false)
    expect(store.consume({ ptyID, ticket: issued.ticket })).toBe(false)
  })

  test("rejects expired tickets", () => {
    let now = 1_000
    const store = new PtyTicketStore({ ttlMs: 100, now: () => now, random: () => "ticket-1" })
    const ptyID = PtyID.ascending()

    const issued = store.issue({ ptyID })
    now = 1_101

    expect(store.consume({ ptyID, ticket: issued.ticket })).toBe(false)
  })

  test("cleans expired tickets when issuing a new ticket", () => {
    let now = 1_000
    let next = 0
    const store = new PtyTicketStore({
      ttlMs: 100,
      now: () => now,
      random: () => `ticket-${++next}`,
    })
    const ptyID = PtyID.ascending()
    const tickets = (store as unknown as { tickets: Map<string, unknown> }).tickets

    store.issue({ ptyID })
    store.issue({ ptyID })
    now = 1_101
    store.issue({ ptyID })

    expect(tickets.size).toBe(1)
  })
})
