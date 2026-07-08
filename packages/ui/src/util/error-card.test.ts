import { describe, expect, test } from "bun:test"
import { errorCardPresentation } from "./error-card"

const apiError = (kind?: string, data: Record<string, unknown> = {}) => ({
  name: "APIError",
  data: { message: "x", ...(kind ? { providerFailure: { kind } } : {}), ...data },
})

describe("errorCardPresentation", () => {
  test("must-act kinds are red and carry a models action", () => {
    for (const kind of ["auth", "quota_exhausted", "invalid_request"] as const) {
      const p = errorCardPresentation(apiError(kind))
      expect(p?.kind).toBe(kind)
      expect(p?.severity).toBe("error")
      expect(p?.rawBody).toBe(false)
      expect(p?.bodyKey).toBe(`ui.errorCard.${kind}.body`)
      expect(p?.titleKey).toBe(`ui.errorCard.${kind}.title`)
      expect(p?.action).toEqual({ labelKey: `ui.errorCard.${kind}.action`, target: "models" })
    }
  })

  test("wait kinds are amber, plain-copy, and have no action", () => {
    for (const kind of ["rate_limit", "server_overload", "transport_disconnect", "decompression"] as const) {
      const p = errorCardPresentation(apiError(kind))
      expect(p?.kind).toBe(kind)
      expect(p?.severity).toBe("warning")
      expect(p?.rawBody).toBe(false)
      expect(p?.bodyKey).toBe(`ui.errorCard.${kind}.body`)
      expect(p?.action).toBeUndefined()
    }
  })

  test("transport_disconnect and decompression render even though they are not provider-API kinds", () => {
    // message-v2.ts sets providerFailure.kind for these stream failures, so the
    // card must classify them — they are not exclusive to the api_error path.
    expect(errorCardPresentation(apiError("transport_disconnect"))?.kind).toBe("transport_disconnect")
    expect(errorCardPresentation(apiError("decompression"))?.kind).toBe("decompression")
  })

  test("unknown shows the decoded reason as body, not a fixed copy key", () => {
    const p = errorCardPresentation(apiError("unknown"))
    expect(p?.kind).toBe("unknown")
    expect(p?.severity).toBe("warning")
    expect(p?.rawBody).toBe(true)
    expect(p?.bodyKey).toBeUndefined()
    expect(p?.action).toBeUndefined()
  })

  test("an error payload with no providerFailure falls back to the unknown presentation", () => {
    const p = errorCardPresentation(apiError(undefined, { responseBody: "boom" }))
    expect(p?.kind).toBe("unknown")
    expect(p?.rawBody).toBe(true)
  })

  test("an unrecognized kind string falls back to unknown rather than trusting it", () => {
    const p = errorCardPresentation(apiError("teapot"))
    expect(p?.kind).toBe("unknown")
  })

  test("prototype keys cannot pose as a kind (no Object.prototype bypass)", () => {
    // `"constructor" in PRESENTATION` is true; the lookup must use own-key checks
    // so these fall back to unknown instead of building a key from the string.
    for (const kind of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      const p = errorCardPresentation(apiError(kind))
      expect(p?.kind).toBe("unknown")
      expect(p?.rawBody).toBe(true)
      expect(p?.titleKey).toBe("ui.errorCard.unknown.title")
    }
  })

  test("returns undefined for values that are not an error payload", () => {
    expect(errorCardPresentation("just a string")).toBeUndefined()
    expect(errorCardPresentation(null)).toBeUndefined()
    expect(errorCardPresentation(42)).toBeUndefined()
    expect(errorCardPresentation({ name: "APIError" })).toBeUndefined()
  })
})
