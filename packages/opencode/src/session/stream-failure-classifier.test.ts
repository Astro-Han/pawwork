import { describe, expect, test } from "bun:test"
import { classifyStreamFailure } from "./stream-failure-classifier"

describe("classifyStreamFailure", () => {
  describe("transport disconnect — retryable", () => {
    test("ECONNRESET SystemError", () => {
      const error = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET", syscall: "read" })
      const result = classifyStreamFailure(error)
      expect(result).toEqual({
        kind: "provider_transport_disconnect",
        retryable: true,
        code: "ECONNRESET",
      })
    })

    test("UND_ERR_SOCKET — TypeError('terminated') with cause.code", () => {
      const cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" })
      const error = new TypeError("terminated", { cause })
      const result = classifyStreamFailure(error)
      expect(result).toEqual({
        kind: "provider_transport_disconnect",
        retryable: true,
        code: "UND_ERR_SOCKET",
      })
    })

    test("ECONNREFUSED SystemError", () => {
      const error = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED", syscall: "connect" })
      const result = classifyStreamFailure(error)
      expect(result).toEqual({
        kind: "provider_transport_disconnect",
        retryable: true,
        code: "ECONNREFUSED",
      })
    })

    test("ETIMEDOUT SystemError", () => {
      const error = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT", syscall: "connect" })
      const result = classifyStreamFailure(error)
      expect(result).toEqual({
        kind: "provider_transport_disconnect",
        retryable: true,
        code: "ETIMEDOUT",
      })
    })

    test("UND_ERR_SOCKET nested in cause chain", () => {
      const innerCause = Object.assign(new Error("socket hang up"), { code: "UND_ERR_SOCKET" })
      const midError = new Error("fetch failed", { cause: innerCause })
      const outerError = new TypeError("terminated", { cause: midError })
      const result = classifyStreamFailure(outerError)
      expect(result).toEqual({
        kind: "provider_transport_disconnect",
        retryable: true,
        code: "UND_ERR_SOCKET",
      })
    })
  })

  describe("non-transport errors — not classified", () => {
    test("generic Error returns undefined", () => {
      expect(classifyStreamFailure(new Error("something broke"))).toBeUndefined()
    })

    test("TypeError without transport cause returns undefined", () => {
      expect(classifyStreamFailure(new TypeError("Cannot read properties of undefined"))).toBeUndefined()
    })

    test("AbortError returns undefined", () => {
      const error = new DOMException("The operation was aborted", "AbortError")
      expect(classifyStreamFailure(error)).toBeUndefined()
    })

    test("non-Error values return undefined", () => {
      expect(classifyStreamFailure("string error")).toBeUndefined()
      expect(classifyStreamFailure(null)).toBeUndefined()
      expect(classifyStreamFailure(42)).toBeUndefined()
    })

    test("TypeError('terminated') without UND_ERR_SOCKET cause returns undefined", () => {
      const error = new TypeError("terminated", { cause: new Error("unrelated") })
      expect(classifyStreamFailure(error)).toBeUndefined()
    })
  })
})
