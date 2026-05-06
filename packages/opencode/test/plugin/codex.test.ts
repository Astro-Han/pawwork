import { describe, expect, test } from "bun:test"
import {
  CodexAuthPlugin,
  parseJwtClaims,
  extractAccountIdFromClaims,
  extractAccountId,
  formatOAuthFailure,
  hasCodexOAuthGpt55Limit,
  shouldKeepCodexOAuthModel,
  type IdTokenClaims,
} from "../../src/plugin/codex"

function createTestJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.sig`
}

describe("plugin.codex", () => {
  describe("parseJwtClaims", () => {
    test("parses valid JWT with claims", () => {
      const payload = { email: "test@example.com", chatgpt_account_id: "acc-123" }
      const jwt = createTestJwt(payload)
      const claims = parseJwtClaims(jwt)
      expect(claims).toEqual(payload)
    })

    test("returns undefined for JWT with less than 3 parts", () => {
      expect(parseJwtClaims("invalid")).toBeUndefined()
      expect(parseJwtClaims("only.two")).toBeUndefined()
    })

    test("returns undefined for invalid base64", () => {
      expect(parseJwtClaims("a.!!!invalid!!!.b")).toBeUndefined()
    })

    test("returns undefined for invalid JSON payload", () => {
      const header = Buffer.from("{}").toString("base64url")
      const invalidJson = Buffer.from("not json").toString("base64url")
      expect(parseJwtClaims(`${header}.${invalidJson}.sig`)).toBeUndefined()
    })
  })

  describe("extractAccountIdFromClaims", () => {
    test("extracts chatgpt_account_id from root", () => {
      const claims: IdTokenClaims = { chatgpt_account_id: "acc-root" }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-root")
    })

    test("extracts chatgpt_account_id from nested https://api.openai.com/auth", () => {
      const claims: IdTokenClaims = {
        "https://api.openai.com/auth": { chatgpt_account_id: "acc-nested" },
      }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-nested")
    })

    test("prefers root over nested", () => {
      const claims: IdTokenClaims = {
        chatgpt_account_id: "acc-root",
        "https://api.openai.com/auth": { chatgpt_account_id: "acc-nested" },
      }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-root")
    })

    test("extracts from organizations array as fallback", () => {
      const claims: IdTokenClaims = {
        organizations: [{ id: "org-123" }, { id: "org-456" }],
      }
      expect(extractAccountIdFromClaims(claims)).toBe("org-123")
    })

    test("returns undefined when no accountId found", () => {
      const claims: IdTokenClaims = { email: "test@example.com" }
      expect(extractAccountIdFromClaims(claims)).toBeUndefined()
    })
  })

  describe("extractAccountId", () => {
    test("extracts from id_token first", () => {
      const idToken = createTestJwt({ chatgpt_account_id: "from-id-token" })
      const accessToken = createTestJwt({ chatgpt_account_id: "from-access-token" })
      expect(
        extractAccountId({
          id_token: idToken,
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("from-id-token")
    })

    test("falls back to access_token when id_token has no accountId", () => {
      const idToken = createTestJwt({ email: "test@example.com" })
      const accessToken = createTestJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "from-access" },
      })
      expect(
        extractAccountId({
          id_token: idToken,
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("from-access")
    })

    test("returns undefined when no tokens have accountId", () => {
      const token = createTestJwt({ email: "test@example.com" })
      expect(
        extractAccountId({
          id_token: token,
          access_token: token,
          refresh_token: "rt",
        }),
      ).toBeUndefined()
    })

    test("handles missing id_token", () => {
      const accessToken = createTestJwt({ chatgpt_account_id: "acc-123" })
      expect(
        extractAccountId({
          id_token: "",
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("acc-123")
    })
  })

  describe("shouldKeepCodexOAuthModel", () => {
    test("keeps explicit OAuth models and codex API ids", () => {
      expect(shouldKeepCodexOAuthModel("gpt-5.4", "gpt-5.4")).toBe(true)
      expect(shouldKeepCodexOAuthModel("gpt-5.3-codex-spark", "gpt-5.3-codex-spark")).toBe(true)
      expect(shouldKeepCodexOAuthModel("some-codex-model", "custom-model")).toBe(false)
      expect(shouldKeepCodexOAuthModel("custom-alias", "some-codex-model")).toBe(true)
    })

    test("keeps future GPT minor versions using semantic comparison", () => {
      expect(shouldKeepCodexOAuthModel("gpt-5.5", "gpt-5.5")).toBe(true)
      expect(shouldKeepCodexOAuthModel("gpt-5.5-mini", "gpt-5.5-mini")).toBe(true)
      expect(shouldKeepCodexOAuthModel("gpt-5.10", "gpt-5.10")).toBe(true)
      expect(shouldKeepCodexOAuthModel("gpt-6.0", "gpt-6.0")).toBe(true)
    })

    test("drops older non-allowlisted GPT and unrelated models", () => {
      expect(shouldKeepCodexOAuthModel("gpt-5.3", "gpt-5.3")).toBe(false)
      expect(shouldKeepCodexOAuthModel("gpt-4.1", "gpt-4.1")).toBe(false)
      expect(shouldKeepCodexOAuthModel("custom-model", "custom-model")).toBe(false)
    })
  })

  describe("hasCodexOAuthGpt55Limit", () => {
    test("matches GPT-5.5 API ids and explicit variants", () => {
      expect(hasCodexOAuthGpt55Limit("gpt-5.5")).toBe(true)
      expect(hasCodexOAuthGpt55Limit("gpt-5.5-codex")).toBe(true)
      expect(hasCodexOAuthGpt55Limit("gpt-5.5-mini")).toBe(true)
    })

    test("does not match unrelated future models", () => {
      expect(hasCodexOAuthGpt55Limit("gpt-5.50")).toBe(false)
      expect(hasCodexOAuthGpt55Limit("chatgpt-5.5")).toBe(false)
      expect(hasCodexOAuthGpt55Limit("gpt-5.6")).toBe(false)
    })
  })

  describe("CodexAuthPlugin", () => {
    test("filters and normalizes OAuth Codex models through provider model hook", async () => {
      const provider = {
        models: {
          "gpt-5.5": {
            id: "gpt-5.5",
            api: { id: "gpt-5.5" },
            cost: {
              input: 2,
              output: 8,
              cache: { read: 1, write: 2 },
            },
            limit: {
              context: 1_050_000,
              input: 922_000,
              output: 128_000,
            },
          },
          "gpt-5.3-codex-spark": {
            id: "gpt-5.3-codex-spark",
            api: { id: "gpt-5.3-codex-spark" },
            cost: {
              input: 2,
              output: 8,
              cache: { read: 1, write: 2 },
            },
            limit: {
              context: 1_000_000,
              output: 128_000,
            },
          },
          "gpt-5.3": {
            id: "gpt-5.3",
            api: { id: "gpt-5.3" },
            cost: {
              input: 2,
              output: 8,
              cache: { read: 1, write: 2 },
            },
            limit: {
              context: 1_000_000,
              output: 128_000,
            },
          },
        },
      }

      expect(provider.models["gpt-5.5"].limit).toEqual({
        context: 1_050_000,
        input: 922_000,
        output: 128_000,
      })

      const hooks = await CodexAuthPlugin({
        client: {} as never,
        project: {} as never,
        directory: "",
        worktree: "",
        experimental_workspace: {
          register() {},
        },
      } as never)

      const models = await hooks.provider!.models!(provider as never, {
        auth: {
          type: "oauth",
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 60_000,
        } as never,
      })

      expect(models["gpt-5.3"]).toBeUndefined()
      expect(models["gpt-5.3-codex-spark"]).toBeDefined()
      expect(models["gpt-5.5"].limit).toEqual({
        context: 400_000,
        input: 272_000,
        output: 128_000,
      })
      expect(models["gpt-5.5"].cost).toEqual({
        input: 0,
        output: 0,
        cache: { read: 0, write: 0 },
      })
    })
  })

  describe("formatOAuthFailure", () => {
    test("includes safe JSON error fields and request metadata", async () => {
      const response = new Response(
        JSON.stringify({
          error: {
            code: "unsupported_country_region_territory",
            type: "request_forbidden",
            message: "Country, region, or territory not supported",
          },
        }),
        {
          status: 403,
          headers: {
            "content-type": "application/json",
            "x-request-id": "req_123",
            "cf-ray": "ray_123",
            "cf-mitigated": "challenge",
          },
        },
      )

      expect(await formatOAuthFailure("Token exchange", response)).toBe(
        "Token exchange failed (status=403, request_id=req_123, cf_ray=ray_123, cf_mitigated=challenge, code=unsupported_country_region_territory, type=request_forbidden, message=Country, region, or territory not supported)",
      )
    })

    test("falls back to status and headers when response is not JSON", async () => {
      const response = new Response("<html>blocked</html>", {
        status: 403,
        headers: {
          "content-type": "text/html",
          "x-request-id": "req_html",
        },
      })

      expect(await formatOAuthFailure("Token exchange", response)).toBe(
        "Token exchange failed (status=403, request_id=req_html)",
      )
    })
  })
})
