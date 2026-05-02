import { describe, expect, test } from "bun:test"
import { attachRendererDiagnosticsToSessionExport } from "./server-client"

describe("server client", () => {
  test("attaches renderer diagnostics to object session exports", () => {
    const body = JSON.stringify({ session: { id: "ses_1" }, messages: [] })
    const next = attachRendererDiagnosticsToSessionExport(body, {
      status: "ok",
      source: "renderer-diagnostics",
      events: [],
    })

    expect(JSON.parse(next)).toEqual({
      session: { id: "ses_1" },
      messages: [],
      renderer_diagnostics: {
        status: "ok",
        source: "renderer-diagnostics",
        events: [],
      },
    })
  })

  test("leaves invalid or non-object session exports unchanged", () => {
    expect(attachRendererDiagnosticsToSessionExport("{", { status: "ok" })).toBe("{")
    expect(attachRendererDiagnosticsToSessionExport("[]", { status: "ok" })).toBe("[]")
  })
})
