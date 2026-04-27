import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Auth } from "../../src/auth"
import { WebSearchAuth } from "../../src/tool/websearch-auth"

function authLayer(initial: Record<string, Auth.Info> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    layer: Layer.succeed(
      Auth.Service,
      Auth.Service.of({
        get: (key) => Effect.succeed(data.get(key)),
        all: () => Effect.succeed(Object.fromEntries(data)),
        set: (key, info) =>
          Effect.sync(() => {
            data.set(key, info)
          }),
        remove: (key) =>
          Effect.sync(() => {
            data.delete(key)
          }),
      }),
    ),
  }
}

function runWith(input: {
  auth: ReturnType<typeof authLayer>
  effect: Effect.Effect<unknown, unknown, WebSearchAuth.Service>
}) {
  return Effect.runPromise(input.effect.pipe(Effect.provide(WebSearchAuth.layer), Effect.provide(input.auth.layer)))
}

describe("WebSearchAuth", () => {
  const originalExaApiKey = process.env.EXA_API_KEY

  afterEach(() => {
    if (originalExaApiKey === undefined) delete process.env.EXA_API_KEY
    else process.env.EXA_API_KEY = originalExaApiKey
  })

  test("saves a submitted key without spending search quota on validation", async () => {
    delete process.env.EXA_API_KEY
    const auth = authLayer()
    const status = (await runWith({
      auth,
      effect: WebSearchAuth.Service.use((svc) => svc.saveKey(" submitted-key ")),
    })) as WebSearchAuth.Status

    expect(status).toEqual({ source: "saved", configured: true, needsAttention: false, quotaExceeded: false })
    expect(auth.data.get(WebSearchAuth.AUTH_KEY)).toMatchObject({
      type: "api",
      key: "submitted-key",
      metadata: { status: "configured", credentialVersion: expect.any(String) },
    })
  })

  test("rejects saving over an env-backed key state", async () => {
    process.env.EXA_API_KEY = "env-key"
    const auth = authLayer()
    await expect(
      runWith({
        auth,
        effect: WebSearchAuth.Service.use((svc) => svc.saveKey(" submitted-key ")),
      }),
    ).rejects.toThrow("EXA_API_KEY is already active. Clear it before saving a key in Settings.")

    expect(auth.data.has(WebSearchAuth.AUTH_KEY)).toBe(false)
  })

  test("updates an existing saved key even when env is present", async () => {
    process.env.EXA_API_KEY = "env-key"
    const auth = authLayer({
      [WebSearchAuth.AUTH_KEY]: new Auth.Api({
        type: "api",
        key: "old-saved-key",
        metadata: { status: "configured", credentialVersion: "old-version" },
      }),
    })

    const status = (await runWith({
      auth,
      effect: WebSearchAuth.Service.use((svc) => svc.saveKey(" new-saved-key ")),
    })) as WebSearchAuth.Status

    expect(status).toEqual({ source: "saved", configured: true, needsAttention: false, quotaExceeded: false })
    expect(auth.data.get(WebSearchAuth.AUTH_KEY)).toMatchObject({
      type: "api",
      key: "new-saved-key",
      metadata: { status: "configured", credentialVersion: expect.any(String) },
    })
    const saved = auth.data.get(WebSearchAuth.AUTH_KEY)
    expect(saved?.type).toBe("api")
    if (saved?.type === "api") {
      expect(saved.metadata?.credentialVersion).not.toBe("old-version")
    }
  })

  test("prefers a saved key over env and returns status without key material", async () => {
    process.env.EXA_API_KEY = "env-key"
    const auth = authLayer({
      [WebSearchAuth.AUTH_KEY]: new Auth.Api({
        type: "api",
        key: "saved-key",
        metadata: { status: "configured" },
      }),
    })

    const saved = (await runWith({
      auth,
      effect: WebSearchAuth.Service.use((svc) => svc.credential()),
    })) as WebSearchAuth.Credential
    const savedStatus = (await runWith({
      auth,
      effect: WebSearchAuth.Service.use((svc) => svc.status()),
    })) as WebSearchAuth.Status

    expect(saved).toEqual({ source: "saved", key: "saved-key" })
    expect(savedStatus).toEqual({ source: "saved", configured: true, needsAttention: false, quotaExceeded: false })
    expect(JSON.stringify(savedStatus)).not.toContain("saved-key")

    await runWith({
      auth,
      effect: WebSearchAuth.Service.use((svc) => svc.removeKey()),
    })

    const fallback = (await runWith({
      auth,
      effect: WebSearchAuth.Service.use((svc) => svc.status()),
    })) as WebSearchAuth.Status

    expect(fallback).toEqual({ source: "env", configured: true, needsAttention: false, quotaExceeded: false })
    expect(JSON.stringify(fallback)).not.toContain("env-key")
  })

  test("persists anonymous bundled quota exhaustion without key material", async () => {
    const auth = authLayer()

    await runWith({
      auth,
      effect: WebSearchAuth.Service.use((svc) =>
        svc.markNeedsAttention({ kind: "quota_exceeded", source: "anonymous", status: 429 }),
      ),
    })

    const status = (await runWith({
      auth,
      effect: WebSearchAuth.Service.use((svc) => svc.status()),
    })) as WebSearchAuth.Status

    expect(status).toEqual({
      source: "anonymous",
      configured: false,
      needsAttention: false,
      quotaExceeded: true,
    })
    expect(JSON.stringify(auth.data.get(WebSearchAuth.AUTH_KEY))).not.toContain("exaApiKey")
  })

  test("does not mark a new saved key from an older request failure", async () => {
    const auth = authLayer({
      [WebSearchAuth.AUTH_KEY]: new Auth.Api({
        type: "api",
        key: "new-key",
        metadata: { status: "configured", credentialVersion: "new-version" },
      }),
    })

    await runWith({
      auth,
      effect: WebSearchAuth.Service.use((svc) =>
        svc.markNeedsAttention({
          kind: "invalid_key",
          source: "saved",
          status: 401,
          credentialVersion: "old-version",
        }),
      ),
    })

    expect(auth.data.get(WebSearchAuth.AUTH_KEY)).toMatchObject({
      type: "api",
      key: "new-key",
      metadata: { status: "configured", credentialVersion: "new-version" },
    })
  })

  test("tracks saved key quota separately from invalid-key attention", async () => {
    const auth = authLayer({
      [WebSearchAuth.AUTH_KEY]: new Auth.Api({
        type: "api",
        key: "saved-key",
        metadata: { status: "configured", credentialVersion: "saved-version" },
      }),
    })

    await runWith({
      auth,
      effect: WebSearchAuth.Service.use((svc) =>
        svc.markNeedsAttention({
          kind: "quota_exceeded",
          source: "saved",
          status: 429,
          credentialVersion: "saved-version",
        }),
      ),
    })

    const status = (await runWith({
      auth,
      effect: WebSearchAuth.Service.use((svc) => svc.status()),
    })) as WebSearchAuth.Status

    expect(status).toEqual({ source: "saved", configured: true, needsAttention: false, quotaExceeded: true })
    expect(auth.data.get(WebSearchAuth.AUTH_KEY)).toMatchObject({
      type: "api",
      key: "saved-key",
      metadata: { status: "quota_exceeded", reason: "quota_exceeded", credentialVersion: "saved-version" },
    })
  })
})
