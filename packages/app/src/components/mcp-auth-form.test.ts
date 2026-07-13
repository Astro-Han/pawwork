import { describe, expect, test } from "bun:test"
import { readMcpAuth, writeMcpAuth } from "./mcp-auth-form"

describe("MCP authentication form", () => {
  test("maps one Bearer authorization header to the token form without duplicating config state", () => {
    expect(readMcpAuth({ Authorization: "Bearer {env:MCP_TOKEN}" })).toEqual({
      mode: "bearer",
      token: "{env:MCP_TOKEN}",
    })
    expect(writeMcpAuth("bearer", "  {env:MCP_TOKEN}  ", { Ignored: "value" })).toEqual({
      Authorization: "Bearer {env:MCP_TOKEN}",
    })
  })

  test("keeps non-Bearer and multi-header authentication in the advanced form", () => {
    const headers = { "X-API-Key": "secret", "X-Workspace": "docs" }
    expect(readMcpAuth(headers)).toEqual({ mode: "headers", token: "" })
    expect(writeMcpAuth("headers", "ignored", headers)).toEqual(headers)
  })

  test("omits authentication when the selected form is empty", () => {
    expect(readMcpAuth(undefined)).toEqual({ mode: "bearer", token: "" })
    expect(writeMcpAuth("bearer", "  ", undefined)).toBeUndefined()
    expect(writeMcpAuth("headers", "", {})).toBeUndefined()
  })
})
