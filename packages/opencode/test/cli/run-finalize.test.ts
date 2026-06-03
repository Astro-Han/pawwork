import { describe, expect, test } from "bun:test"
import { runExitCode, drainTrailingOutput } from "@/cli/cmd/run"

// R3.6 (#26955 + #27371): a non-interactive `run` must flush trailing output
// before teardown and report a non-zero exit code on a TERMINAL failure, without
// hanging when the drain stream stalls.
describe("CLI run exit code (#26955/#27371)", () => {
  test("a clean run exits zero", () => {
    expect(runExitCode({})).toBeUndefined()
    expect(runExitCode({ data: { info: {} } })).toBeUndefined()
  })

  test("a shaped SDK request error (rejected before a turn ran) exits non-zero", () => {
    expect(runExitCode({ error: { name: "BadRequest" } })).toBe(1)
  })

  test("a terminal error on the final assistant message exits non-zero", () => {
    expect(runExitCode({ data: { info: { error: { name: "ProviderError" } } } })).toBe(1)
  })

  test("a recovered intermediate error (final message has no error) exits zero", () => {
    // A ContextOverflowError that auto-compacts and then continues leaves the
    // final assistant message without an error — the run succeeded, so the
    // intermediate session.error must not fail the exit code.
    expect(runExitCode({ data: { info: {} } })).toBeUndefined()
  })
})

describe("CLI run drain (#26955)", () => {
  test("returns as soon as the stream reaches idle", async () => {
    let aborted = false
    await drainTrailingOutput(Promise.resolve(), () => performance.now(), {
      abort: () => {
        aborted = true
      },
    })
    expect(aborted).toBe(false)
  })

  test("aborts a stalled stream instead of hanging", async () => {
    // The drain never resolves and no events arrive (the last event is ancient),
    // so the watchdog must abort the subscription rather than wait forever.
    let aborted = false
    const neverDrains = new Promise<void>(() => {})
    await drainTrailingOutput(
      neverDrains,
      () => 0,
      {
        abort: () => {
          aborted = true
        },
      },
      20,
    )
    expect(aborted).toBe(true)
  })
})
