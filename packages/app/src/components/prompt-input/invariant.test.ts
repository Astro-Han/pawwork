import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { reportInvariantBreach } from "./invariant"

describe("reportInvariantBreach", () => {
  let originalEnv: any
  beforeEach(() => { originalEnv = (globalThis as any).__import_meta_env_dev })
  afterEach(() => { (globalThis as any).__import_meta_env_dev = originalEnv })

  test("non-dev env (import.meta.env undefined) does not throw synchronously", () => {
    expect(() => reportInvariantBreach("test", { foo: "bar" })).not.toThrow()
  })

  // dev-throw path is exercised via assertCommandTextPart in command-text-part.test.ts.
  // No need to fake import.meta.env in Bun — see spec L520.
})
