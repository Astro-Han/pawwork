import { createServer } from "node:http"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, test } from "vitest"
import { installedHarnessPackages } from "./dsh-product-patch.testing"

/**
 * Guards the failure-classification half of `patches/@deepseek-ai__dsh-llm-pi-ai@<version>.patch`.
 * DSH folds every 401 and every 403 into the `AUTH` code, and the chat client renders `AUTH` as
 * "API key is invalid" instead of the message the provider sent. A gateway that refuses a request
 * for another reason therefore reaches the user as a credential problem with the reason erased —
 * which is how Zen's free-tier gate (403, FreeTierError) was reported as a wrong API key. The patch
 * keeps 401 as the auth verdict and lets a 403 fall through, where its own words survive.
 */

/** The OpenCode Free route, as the product patch configures it, pointed at a local server. */
async function failureFromProvider(status: number, body: string) {
  const server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" })
    response.end(body)
  })
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening))

  try {
    const directory = installedHarnessPackages().get("@deepseek-ai/dsh-llm-pi-ai")
    if (directory === undefined) throw new Error("dsh-llm-pi-ai is not installed")
    const adapter = (await import(pathToFileURL(join(directory, "lib", "index.js")).href)) as {
      apply: (context: unknown, config: unknown) => void
    }

    let registered: {
      prepareCall: (provider: string, model: string) => Promise<{
        stream: (options: unknown) => AsyncIterable<{ type: string; reason?: { failure?: unknown } }>
      }>
    } | undefined
    const noop = () => {}
    const ctx = {
      effect: () => noop,
      get: () => undefined,
      inject: noop,
      llm: {
        registerAdapter: (_routes: string[], candidate: typeof registered) => {
          registered = candidate
          return { replace: noop }
        },
        registerConfigurableProviders: () => ({ replace: noop }),
        registerModelDiscovery: noop,
      },
      logger: { debug: noop, error: noop, info: noop, warn: noop },
      on: () => noop,
    }

    process.env.PAWWORK_TEST_FREE_MODEL_KEY = "public"
    adapter.apply(ctx, {
      providers: {
        opencode: {
          apiKeyEnv: "PAWWORK_TEST_FREE_MODEL_KEY",
          api: "openai-completions",
          baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
          models: [{ id: "big-pickle" }],
        },
      },
    })

    if (registered === undefined) throw new Error("the adapter registered no route to call")
    const prepared = await registered.prepareCall("opencode", "big-pickle")

    let failure: { message?: string; code?: string } | undefined
    for await (const chunk of prepared.stream({
      provider: "opencode",
      model: "big-pickle",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    })) {
      if (chunk.type === "finish") failure = chunk.reason?.failure as typeof failure
    }
    return failure
  } finally {
    delete process.env.PAWWORK_TEST_FREE_MODEL_KEY
    server.close()
  }
}

describe("pi-ai failure classification", () => {
  test("keeps a refused request out of AUTH, so the reason survives to the UI", async () => {
    const gate = "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode"
    const failure = await failureFromProvider(403, JSON.stringify({ type: "error", error: { type: "FreeTierError", message: gate } }))

    expect(failure?.code).not.toBe("AUTH")
    expect(failure?.message).toContain(gate)
  })

  test("still reads a rejected credential as AUTH", async () => {
    const failure = await failureFromProvider(401, JSON.stringify({ type: "error", error: { type: "AuthError", message: "Invalid API key." } }))

    expect(failure?.code).toBe("AUTH")
  })
})
