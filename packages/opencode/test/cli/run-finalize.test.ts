import { describe, expect, test } from "bun:test"
import { finalizeRun } from "@/cli/cmd/run"

// R3.6 (#26955 + #27371): a non-interactive `run` must wait for the SSE event
// stream to finish draining (so trailing JSON/text is not dropped when the
// instance is disposed) and report a non-zero exit code on failure — without
// hanging when the request was rejected before a turn ever ran.
describe("CLI run finalizeRun (#26955/#27371: drain + exit code)", () => {
  test("a clean run drains the loop and exits zero", async () => {
    expect(await finalizeRun(Promise.resolve(undefined), {})).toBeUndefined()
  })

  test("a session error accumulated by the drained loop exits non-zero", async () => {
    expect(await finalizeRun(Promise.resolve("provider request failed"), {})).toBe(1)
  })

  test("a shaped SDK request error exits non-zero", async () => {
    expect(await finalizeRun(Promise.resolve(undefined), { error: { name: "BadRequest" } })).toBe(1)
  })

  test("a request error fails fast without awaiting the drain loop (no hang)", async () => {
    // A request rejected before a turn ran never produces a `session.status:
    // idle` event, so the drain loop never resolves. finalizeRun must short
    // circuit on `result.error` instead of awaiting it — otherwise this test
    // would hang and time out.
    const neverDrains = new Promise<string | undefined>(() => {})
    expect(await finalizeRun(neverDrains, { error: { name: "NotFoundError" } })).toBe(1)
  })
})
