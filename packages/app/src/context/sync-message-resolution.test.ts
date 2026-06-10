import { describe, expect, test } from "bun:test"
import { resolveLoadMessagePage, resolveLoadMessagePageMeta } from "./sync"

type TestMsg = { id: string; text: string }

const m = (id: string, text: string): TestMsg => ({ id, text })

describe("resolveLoadMessagePage", () => {
  test("normal initial load without stored data returns fetched as-is", () => {
    const fetched = [m("msg_1", "hello"), m("msg_2", "world")]
    const result = resolveLoadMessagePage<TestMsg>({
      stored: undefined,
      fetched,
    })
    expect(result.map((x) => x.id)).toEqual(["msg_1", "msg_2"])
  })

  test("race window: SSE data in store, no metadata — merge protects event data from stale GET", () => {
    // SSE events wrote msg_1 (from shell) into the store
    const stored = [m("msg_1", "shell-user")]
    // GET returns empty because it hit the server before shell created messages
    const fetched: TestMsg[] = []
    const result = resolveLoadMessagePage<TestMsg>({
      stored,
      fetched,
    })
    // msg_1 from SSE should survive
    expect(result.map((x) => x.id)).toEqual(["msg_1"])
    expect(result.map((x) => x.text)).toEqual(["shell-user"])
  })

  test("race window: SSE + GET both have data — merge fills gaps", () => {
    // SSE events wrote msg_1
    const stored = [m("msg_1", "shell-user")]
    // GET returns msg_1 (from DB, might be more complete) and msg_2
    const fetched = [m("msg_1", "shell-user-db"), m("msg_2", "shell-assistant")]
    const result = resolveLoadMessagePage<TestMsg>({
      stored,
      fetched,
    })
    // Both messages present, msg_1 uses fetched version (source of truth for same ID)
    expect(result.map((x) => x.id)).toEqual(["msg_1", "msg_2"])
    expect(result.map((x) => x.text)).toEqual(["shell-user-db", "shell-assistant"])
  })

  test("normal refresh with cached meta keeps the loaded message set monotonic", () => {
    const stored = [m("msg_1", "old"), m("msg_2", "visible")]
    const fetched = [m("msg_1", "current")]
    const result = resolveLoadMessagePage<TestMsg>({
      stored,
      fetched,
    })
    expect(result.map((x) => x.id)).toEqual(["msg_1", "msg_2"])
    expect(result.map((x) => x.text)).toEqual(["current", "visible"])
  })

  test("normal refresh without stored data returns fetched as-is", () => {
    const fetched = [m("msg_1", "hello")]
    const result = resolveLoadMessagePage<TestMsg>({
      stored: undefined,
      fetched,
    })
    expect(result.map((x) => x.id)).toEqual(["msg_1"])
  })

  test("loaded history pages merge stored with fetched", () => {
    const stored = [m("msg_3", "existing"), m("msg_4", "existing")]
    const fetched = [m("msg_1", "older"), m("msg_2", "older")]
    const result = resolveLoadMessagePage<TestMsg>({
      stored,
      fetched,
    })
    // Sorted by ID: older messages first
    expect(result.map((x) => x.id)).toEqual(["msg_1", "msg_2", "msg_3", "msg_4"])
    // Retrieved messages override existing ones with same ID
  })

  test("fetched overrides stored when same ID", () => {
    const stored = [m("msg_1", "stale")]
    const fetched = [m("msg_1", "fresh")]
    const result = resolveLoadMessagePage<TestMsg>({
      stored,
      fetched,
    })
    expect(result.map((x) => x.text)).toEqual(["fresh"])
  })

  test("race window: empty stored array does not trigger merge", () => {
    // An empty stored array (failed initial load, no event data) should still fall through to replace
    const stored: TestMsg[] = []
    const fetched = [m("msg_1", "hello")]
    const result = resolveLoadMessagePage<TestMsg>({
      stored,
      fetched,
    })
    expect(result.map((x) => x.id)).toEqual(["msg_1"])
  })

  test("race window: fetched overrides stored for same message ID — intentional strategy", () => {
    // SSE events wrote msg_1 with a running tool part; the subsequent
    // GET returns msg_1 with the completed state. Fetched data from the
    // DB is at least as fresh as SSE events from the same shell execution.
    const stored = [m("msg_1", "running")]
    const fetched = [m("msg_1", "completed")]
    const result = resolveLoadMessagePage<TestMsg>({
      stored,
      fetched,
    })
    expect(result.map((x) => x.text)).toEqual(["completed"])
  })
})

describe("resolveLoadMessagePageMeta", () => {
  test("replace refresh with retained messages keeps the previous pagination boundary", () => {
    const result = resolveLoadMessagePageMeta({
      mode: "replace",
      previous: { limit: 11, cursor: "msg_03", complete: false },
      messageCount: 11,
      fetchedCount: 2,
      fetchedCursor: "msg_09",
      fetchedComplete: false,
    })

    expect(result).toEqual({ limit: 11, cursor: "msg_03", complete: false })
  })

  test("prepend history load advances the pagination boundary", () => {
    const result = resolveLoadMessagePageMeta({
      mode: "prepend",
      previous: { limit: 11, cursor: "msg_03", complete: false },
      messageCount: 14,
      fetchedCount: 3,
      fetchedCursor: "msg_00",
      fetchedComplete: false,
    })

    expect(result).toEqual({ limit: 14, cursor: "msg_00", complete: false })
  })
})
