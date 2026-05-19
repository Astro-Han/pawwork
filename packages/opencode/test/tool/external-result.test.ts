import { describe, expect, test } from "bun:test"
import { ExternalResult } from "../../src/tool/external-result"

describe("tool.external-result.ExternalResultError", () => {
  test("constructs with reason aborted; tag and reason are set", () => {
    const err = new ExternalResult.Error({ reason: "aborted" })
    expect(err._tag).toBe("ExternalResultError")
    expect(err.reason).toBe("aborted")
  })

  test("constructs with reason shutdown", () => {
    const err = new ExternalResult.Error({ reason: "shutdown" })
    expect(err._tag).toBe("ExternalResultError")
    expect(err.reason).toBe("shutdown")
  })

  test("is an Error instance (works with instanceof)", () => {
    const err = new ExternalResult.Error({ reason: "aborted" })
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(ExternalResult.Error)
  })

  test("message includes the reason", () => {
    const aborted = new ExternalResult.Error({ reason: "aborted" })
    const shutdown = new ExternalResult.Error({ reason: "shutdown" })
    expect(aborted.message).toContain("aborted")
    expect(shutdown.message).toContain("shutdown")
  })
})
