import { describe, expect, test } from "bun:test"
import { resolveSkipAction } from "./session-question-dock"

describe("resolveSkipAction", () => {
  test("navigates to next unsettled question when one exists after current", () => {
    // 3 questions: Q0 settled, Q1 unsettled, Q2 (current) just skipped → now settled
    const isSettled = (i: number) => i !== 1
    const result = resolveSkipAction(2, isSettled, 3)
    expect(result).toEqual({ type: "navigate", tab: 1 })
  })

  test("navigates to first unsettled overall when nothing after current", () => {
    // 3 questions: Q0 unsettled, Q1 settled, Q2 (current) just skipped → settled
    const isSettled = (i: number) => i !== 0
    const result = resolveSkipAction(2, isSettled, 3)
    expect(result).toEqual({ type: "navigate", tab: 0 })
  })

  test("submits when there is only one question and it was just skipped", () => {
    // Single question: Q0 just skipped → settled
    const isSettled = () => true
    const result = resolveSkipAction(0, isSettled, 1)
    expect(result).toEqual({ type: "submit" })
  })

  test("submits when all questions are settled after skipping the last one", () => {
    // 3 questions: all settled (Q0 and Q1 answered, Q2 just skipped)
    const isSettled = () => true
    const result = resolveSkipAction(2, isSettled, 3)
    expect(result).toEqual({ type: "submit" })
  })

  test("navigates to next unsettled before current when current is not the last", () => {
    // 3 questions: Q0 settled, Q1 (current) just skipped → settled, Q2 unsettled
    const isSettled = (i: number) => i !== 2
    const result = resolveSkipAction(1, isSettled, 3)
    expect(result).toEqual({ type: "navigate", tab: 2 })
  })
})
