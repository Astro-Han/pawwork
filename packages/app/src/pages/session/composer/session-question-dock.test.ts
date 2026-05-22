import { describe, expect, test } from "bun:test"
import { runBrowserCheck } from "@/testing/browser-subprocess"
import {
  createQuestionResponseGuard,
  isSameQuestionRequest,
  normalizeToolRespondError,
  resolveSkipAction,
} from "./session-question-dock"

describe("resolveSkipAction", () => {
  test("navigates to next unsettled question when one exists after current", () => {
    const isSettled = (i: number) => i !== 1
    const result = resolveSkipAction(2, isSettled, 3)
    expect(result).toEqual({ type: "navigate", tab: 1 })
  })

  test("navigates to first unsettled overall when nothing after current", () => {
    const isSettled = (i: number) => i !== 0
    const result = resolveSkipAction(2, isSettled, 3)
    expect(result).toEqual({ type: "navigate", tab: 0 })
  })

  test("submits when there is only one question and it was just skipped", () => {
    const isSettled = () => true
    const result = resolveSkipAction(0, isSettled, 1)
    expect(result).toEqual({ type: "submit" })
  })

  test("submits when all questions are settled after skipping the last one", () => {
    const isSettled = () => true
    const result = resolveSkipAction(2, isSettled, 3)
    expect(result).toEqual({ type: "submit" })
  })

  test("navigates to next unsettled before current when current is not the last", () => {
    const isSettled = (i: number) => i !== 2
    const result = resolveSkipAction(1, isSettled, 3)
    expect(result).toEqual({ type: "navigate", tab: 2 })
  })
})

describe("normalizeToolRespondError", () => {
  test("normalizes plain already_resolved objects without exposing [object Object]", () => {
    const result = normalizeToolRespondError({ error: "already_resolved" })

    expect(result).toEqual({ type: "already_resolved", requestID: undefined })
    expect(JSON.stringify(result)).not.toContain("[object Object]")
  })

  test("keeps answer_count_mismatch details readable for 422 responses", () => {
    const result = normalizeToolRespondError({
      response: { status: 422 },
      error: "answer_count_mismatch",
      details: { expected: 2, received: 1 },
    })

    expect(result).toEqual({
      type: "invalid_payload",
      detail: 'answer_count_mismatch {"expected":2,"received":1}',
    })
    expect(JSON.stringify(result)).not.toContain("[object Object]")
  })

  test("maps plain no_pending_tool_call body errors to stale session", () => {
    expect(normalizeToolRespondError({ error: "no_pending_tool_call" })).toEqual({ type: "stale_session" })
  })

  test("keeps plain answer_count_mismatch body details readable without a status", () => {
    const result = normalizeToolRespondError({
      error: "answer_count_mismatch",
      details: { expected: 2, received: 1 },
    })

    expect(result).toEqual({
      type: "invalid_payload",
      detail: 'answer_count_mismatch {"expected":2,"received":1}',
    })
    expect(JSON.stringify(result)).not.toContain("[object Object]")
  })

  test("supports common error shapes without stringifying unknown objects", () => {
    expect(normalizeToolRespondError(new Error("network failed"))).toEqual({
      type: "unknown",
      detail: "network failed",
    })
    expect(normalizeToolRespondError("offline")).toEqual({ type: "unknown", detail: "offline" })
    expect(normalizeToolRespondError({ status: 404 })).toEqual({ type: "stale_session" })
    expect(normalizeToolRespondError({ statusCode: 409, request: { id: "req_1" } })).toEqual({
      type: "already_resolved",
      requestID: "req_1",
    })
    expect(normalizeToolRespondError({ nested: true })).toEqual({ type: "unknown" })
  })
})

describe("question response local completion guard", () => {
  const request = { id: "req_1", sessionID: "ses_1", messageID: "msg_1", callID: "call_1" }

  test("does not treat already_resolved as completion without a same-request local submit", () => {
    expect(isSameQuestionRequest(undefined, request, "req_1")).toBe(false)
    expect(isSameQuestionRequest({ ...request, id: "req_other" }, request, "req_1")).toBe(false)
    expect(isSameQuestionRequest({ ...request, callID: "call_other" }, request, "req_1")).toBe(false)
  })

  test("treats already_resolved as idempotent only for the same local request", () => {
    expect(isSameQuestionRequest(request, request, "req_1")).toBe(true)
    expect(isSameQuestionRequest(request, request)).toBe(true)
  })
})

describe("question response duplicate submission guard", () => {
  test("blocks repeated response attempts while pending and while waiting for sync close", () => {
    const guard = createQuestionResponseGuard("req_1")

    expect(guard.begin("req_1")).toBe(true)
    expect(guard.begin("req_1")).toBe(false)

    guard.confirm("req_1")

    expect(guard.canInteract("req_1")).toBe(false)
    expect(guard.begin("req_1")).toBe(false)
  })

  test("restores interaction after failed submit or a new request", () => {
    const guard = createQuestionResponseGuard("req_1")

    expect(guard.begin("req_1")).toBe(true)
    guard.fail("req_1")
    expect(guard.begin("req_1")).toBe(true)

    guard.confirm("req_1")

    expect(guard.canInteract("req_1")).toBe(false)
    expect(guard.canInteract("req_2")).toBe(true)
    expect(guard.begin("req_2")).toBe(true)
  })

  test("updates reactive disabled state immediately after begin and confirm", () => {
    runBrowserCheck(String.raw`
      import { createMemo, createRoot } from "solid-js"
      import { createQuestionResponseGuard } from "./src/pages/session/composer/session-question-dock.tsx"

      const assert = (condition, message) => {
        if (!condition) throw new Error(message)
      }

      createRoot((dispose) => {
        const guard = createQuestionResponseGuard("req_1")
        const disabled = createMemo(() => !guard.canInteract("req_1"))

        assert(disabled() === false, "initial request should be interactive")
        assert(guard.begin("req_1") === true, "first begin should submit")
        assert(disabled() === true, "begin should immediately disable reactive UI")

        guard.fail("req_1")
        assert(disabled() === false, "failure should immediately restore interaction")
        assert(guard.begin("req_1") === true, "retry should submit after failure")
        guard.confirm("req_1")
        assert(disabled() === true, "confirmed response should stay disabled while waiting for sync close")

        dispose()
      })
    `)
  })
})
