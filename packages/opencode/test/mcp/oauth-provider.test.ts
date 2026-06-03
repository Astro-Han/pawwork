import { test, expect, describe } from "bun:test"
import { McpOAuthProvider, type McpOAuthConfig } from "../../src/mcp/oauth-provider"

const makeProvider = (config: McpOAuthConfig) =>
  new McpOAuthProvider("test-server", "https://mcp.example.com/mcp", config, { onRedirect: async () => {} })

describe("McpOAuthProvider.clientMetadata", () => {
  test("includes scope when set in config (#28810)", () => {
    const provider = makeProvider({ scope: "openid offline_access" })
    expect(provider.clientMetadata.scope).toBe("openid offline_access")
  })

  test("omits scope when not set in config", () => {
    const provider = makeProvider({})
    expect(provider.clientMetadata.scope).toBeUndefined()
  })
})
