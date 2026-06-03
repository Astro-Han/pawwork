import { describe, expect, test } from "bun:test"
import { errors } from "../../src/server/error"

describe("errors() response helper", () => {
  test("declares the registered status codes", () => {
    expect(Object.keys(errors(400, 404))).toEqual(["400", "404"])
  })

  test("throws on a status without a registered schema instead of silently dropping it", () => {
    // JSON.stringify omits undefined, so an unregistered code used to vanish
    // from the spec (errors(409) became a no-op). The helper must fail loudly.
    // The signature rejects unknown codes at compile time; cast to exercise the
    // runtime guard for callers that bypass the types.
    const loose = errors as (...codes: number[]) => unknown
    expect(() => loose(409)).toThrow(/no response schema registered for status 409/)
  })
})
