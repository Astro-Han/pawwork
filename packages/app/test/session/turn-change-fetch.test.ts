import { describe, expect, test } from "bun:test"
import { turnFetchSignature, turnFetchTargets } from "@/pages/session/turn-change-fetch"

const SESSION = "ses-1"
const PARENT = "msg-user-1"
const OTHER = "msg-user-2"

describe("turnFetchTargets (P0-1 cache invalidation)", () => {
  test("returns nothing when assistant is still running", () => {
    const out = turnFetchTargets({
      sessionID: SESSION,
      assistants: [{ id: "a1", parentID: PARENT, completed: undefined }],
    })
    expect(out).toEqual([])
  })

  test("includes parent only after all sibling assistants complete", () => {
    const partial = turnFetchTargets({
      sessionID: SESSION,
      assistants: [
        { id: "a1", parentID: PARENT, completed: 100 },
        { id: "a2", parentID: PARENT, completed: undefined },
      ],
    })
    expect(partial).toEqual([])

    const full = turnFetchTargets({
      sessionID: SESSION,
      assistants: [
        { id: "a1", parentID: PARENT, completed: 100 },
        { id: "a2", parentID: PARENT, completed: 200 },
      ],
    })
    expect(full).toHaveLength(1)
    expect(full[0]?.userMessageID).toBe(PARENT)
  })

  test("key changes when a new sibling assistant completes under same parent", () => {
    const after_a1 = turnFetchTargets({
      sessionID: SESSION,
      assistants: [{ id: "a1", parentID: PARENT, completed: 100 }],
    })
    const after_a1_a2 = turnFetchTargets({
      sessionID: SESSION,
      assistants: [
        { id: "a1", parentID: PARENT, completed: 100 },
        { id: "a2", parentID: PARENT, completed: 200 },
      ],
    })
    expect(after_a1).toHaveLength(1)
    expect(after_a1_a2).toHaveLength(1)
    expect(after_a1[0]?.key).not.toBe(after_a1_a2[0]?.key)
  })

  test("key is stable when same set returns in different order", () => {
    const order_a = turnFetchTargets({
      sessionID: SESSION,
      assistants: [
        { id: "a1", parentID: PARENT, completed: 100 },
        { id: "a2", parentID: PARENT, completed: 200 },
      ],
    })
    const order_b = turnFetchTargets({
      sessionID: SESSION,
      assistants: [
        { id: "a2", parentID: PARENT, completed: 200 },
        { id: "a1", parentID: PARENT, completed: 100 },
      ],
    })
    expect(order_a[0]?.key).toBe(order_b[0]?.key)
  })

  test("key changes if completed timestamp changes for same assistant id", () => {
    const t1 = turnFetchTargets({
      sessionID: SESSION,
      assistants: [{ id: "a1", parentID: PARENT, completed: 100 }],
    })
    const t2 = turnFetchTargets({
      sessionID: SESSION,
      assistants: [{ id: "a1", parentID: PARENT, completed: 150 }],
    })
    expect(t1[0]?.key).not.toBe(t2[0]?.key)
  })

  test("emits separate targets per parent", () => {
    const out = turnFetchTargets({
      sessionID: SESSION,
      assistants: [
        { id: "a1", parentID: PARENT, completed: 100 },
        { id: "a2", parentID: OTHER, completed: 200 },
      ],
    })
    expect(out).toHaveLength(2)
    const ids = out.map((t) => t.userMessageID).sort()
    expect(ids).toEqual([PARENT, OTHER].sort())
  })

  test("ignores assistants without parentID", () => {
    const out = turnFetchTargets({
      sessionID: SESSION,
      assistants: [
        { id: "a1", parentID: null, completed: 100 },
        { id: "a2", parentID: undefined, completed: 200 },
      ],
    })
    expect(out).toEqual([])
  })
})

describe("turnFetchSignature", () => {
  test("changes whenever any target key changes", () => {
    const s1 = turnFetchSignature({
      sessionID: SESSION,
      assistants: [{ id: "a1", parentID: PARENT, completed: 100 }],
    })
    const s2 = turnFetchSignature({
      sessionID: SESSION,
      assistants: [
        { id: "a1", parentID: PARENT, completed: 100 },
        { id: "a2", parentID: PARENT, completed: 200 },
      ],
    })
    expect(s1).not.toBe(s2)
    expect(s1.length).toBeGreaterThan(0)
  })

  test("regression: P0-1 sequential a1 -> a2 produces distinct signatures", () => {
    const after_a1 = turnFetchSignature({
      sessionID: SESSION,
      assistants: [{ id: "a1", parentID: PARENT, completed: 100 }],
    })
    const while_a2_running = turnFetchSignature({
      sessionID: SESSION,
      assistants: [
        { id: "a1", parentID: PARENT, completed: 100 },
        { id: "a2", parentID: PARENT, completed: undefined },
      ],
    })
    const after_a2 = turnFetchSignature({
      sessionID: SESSION,
      assistants: [
        { id: "a1", parentID: PARENT, completed: 100 },
        { id: "a2", parentID: PARENT, completed: 200 },
      ],
    })
    expect(after_a1).not.toBe(after_a2)
    expect(while_a2_running).toBe("")
  })
})
