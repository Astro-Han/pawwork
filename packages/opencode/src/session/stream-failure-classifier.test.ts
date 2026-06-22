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

    test("EAI_AGAIN (transient DNS) stays retryable", () => {
      const error = Object.assign(new Error("getaddrinfo EAI_AGAIN api.example.com"), {
        code: "EAI_AGAIN",
        syscall: "getaddrinfo",
      })
      expect(classifyStreamFailure(error)).toEqual({
        kind: "provider_transport_disconnect",
        retryable: true,
        code: "EAI_AGAIN",
      })
    })

    test("UND_ERR_HEADERS_TIMEOUT is a retryable transport disconnect", () => {
      const error = Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" })
      expect(classifyStreamFailure(error)).toEqual({
        kind: "provider_transport_disconnect",
        retryable: true,
        code: "UND_ERR_HEADERS_TIMEOUT",
      })
    })

    test("bare 'socket hang up' message (no errno code) classifies as retryable transport", () => {
      const error = new Error("socket hang up")
      expect(classifyStreamFailure(error)).toEqual({
        kind: "provider_transport_disconnect",
        retryable: true,
        code: "SOCKET_HANG_UP",
      })
    })
  })

  describe("transport disconnect — non-retryable", () => {
    test("ENOTFOUND (unresolved host, likely misconfigured base URL) is not retryable", () => {
      const error = Object.assign(new Error("getaddrinfo ENOTFOUND api.wrong-host.invalid"), {
        code: "ENOTFOUND",
        syscall: "getaddrinfo",
      })
      expect(classifyStreamFailure(error)).toEqual({
        kind: "provider_transport_disconnect",
        retryable: false,
        code: "ENOTFOUND",
      })
    })

    test("ENOTFOUND nested in cause chain is not retryable", () => {
      const cause = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" })
      const error = new TypeError("fetch failed", { cause })
      expect(classifyStreamFailure(error)).toEqual({
        kind: "provider_transport_disconnect",
        retryable: false,
        code: "ENOTFOUND",
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

    test("message fallback does not hijack an HTTP error that mentions 'socket hang up'", () => {
      // An error carrying an HTTP statusCode is an API error classified by status
      // downstream; a transport phrase in its message must not reclassify it.
      const error = Object.assign(new Error("400 invalid request: socket hang up is not allowed"), {
        statusCode: 400,
      })
      expect(classifyStreamFailure(error)).toBeUndefined()
    })

    test("HTTP error with a transport-coded cause is still classified by status, not transport", () => {
      // statusCode present = HTTP response received = API error. A transport code
      // on its cause must not reclassify it as a transport disconnect.
      const cause = Object.assign(new Error("socket hang up"), { code: "UND_ERR_SOCKET" })
      const error = Object.assign(new Error("400 invalid request"), { statusCode: 400, cause })
      expect(classifyStreamFailure(error)).toBeUndefined()
    })
  })
})
