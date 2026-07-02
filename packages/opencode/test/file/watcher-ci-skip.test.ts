import { describe, expect, test } from "bun:test"
import { shouldRunNativeWatcherTests } from "./native-watcher-ci-guard"

describe("watcher CI skip guards", () => {
  test("skips CI without probing native bindings", () => {
    let probed = false

    const shouldRun = shouldRunNativeWatcherTests(() => {
      probed = true
      return true
    }, { CI: "1" })

    expect(shouldRun).toBe(false)
    expect(probed).toBe(false)
  })

  test("runs outside CI when native bindings are available", () => {
    let probed = false

    const shouldRun = shouldRunNativeWatcherTests(() => {
      probed = true
      return true
    }, {})

    expect(shouldRun).toBe(true)
    expect(probed).toBe(true)
  })
})
