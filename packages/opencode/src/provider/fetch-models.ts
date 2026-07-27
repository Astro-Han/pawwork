import { z } from "zod"

// Discover model IDs from an OpenAI-compatible provider/gateway `/models` endpoint.
// Mirrors the fetch+parse precedent in plugin/github-copilot/models.ts, but stays
// generic: we only keep id + display name, never infer capabilities from arbitrary
// gateway IDs (wrong metadata would break agent behavior — see issue #1463).
export namespace FetchModels {
  const OPENAI_COMPATIBLE = "@ai-sdk/openai-compatible"
  // Inference adapters are not model-discovery contracts. Profiles describe providers whose
  // discovery protocol is native or differs from the adapter/base URL used for inference.
  type DiscoveryProfile = {
    apiKeyHeader?: "authorization" | "x-api-key"
    baseURL?: string
    headers?: Record<string, string>
  }
  const discoveryProfiles: Record<string, DiscoveryProfile> = {
    anthropic: {
      apiKeyHeader: "x-api-key",
      baseURL: "https://api.anthropic.com/v1",
      headers: { "anthropic-version": "2023-06-01" },
    },
    freemodel: {},
    "kimi-for-coding": {},
    minimax: { baseURL: "https://api.minimax.io/v1" },
    "minimax-coding-plan": { baseURL: "https://api.minimax.io/v1" },
    "minimax-cn": { baseURL: "https://api.minimaxi.com/v1" },
    "minimax-cn-coding-plan": { baseURL: "https://api.minimaxi.com/v1" },
    openai: { baseURL: "https://api.openai.com/v1" },
    subconscious: {},
  }

  const Item = z.object({
    id: z.string(),
    name: z.string().optional(),
    display_name: z.string().optional(),
  })
  const Shape = z.union([
    z.object({ data: z.array(z.unknown()) }),
    z.object({ models: z.array(z.unknown()) }),
    z.array(z.unknown()),
  ])

  export type Parsed = { id: string; name: string }

  // Accept the three shapes seen in the wild: { data: [...] } (OpenAI), { models: [...] }, or a bare array.
  // Throw on anything else so the caller can surface "this endpoint isn't a models API"; a valid but empty
  // list is not an error — it just means there is nothing to add.
  export function parse(json: unknown): Parsed[] {
    const shaped = Shape.safeParse(json)
    if (!shaped.success) throw new Error("Unexpected models response shape")
    const rows = Array.isArray(shaped.data)
      ? shaped.data
      : "data" in shaped.data
        ? shaped.data.data
        : shaped.data.models

    const seen = new Set<string>()
    const result: Parsed[] = []
    for (const row of rows) {
      const item = Item.safeParse(row)
      if (!item.success) continue
      const id = item.data.id.trim()
      if (!id || seen.has(id)) continue
      seen.add(id)
      result.push({ id, name: item.data.name?.trim() || item.data.display_name?.trim() || id })
    }
    return result
  }

  export function endpoint(baseURL: string): string {
    return `${baseURL.trim().replace(/\/+$/, "")}/models`
  }

  export type RequestInput = {
    // Provider config `options` (user override): endpoint/baseURL/apiKey/headers.
    configOptions?: {
      endpoint?: string
      baseURL?: string
      apiKey?: string
      headers?: Record<string, unknown>
    }
    // API key from the auth store (preferred over a config-embedded apiKey).
    authKey?: string
    // models.dev catalog base URL, used when the user has not overridden one.
    catalogBaseURL?: string
  }

  type ProfileRequestInput = RequestInput & {
    apiKeyHeader?: DiscoveryProfile["apiKeyHeader"]
    defaultHeaders?: Record<string, string>
  }

  export type ResolveInput = RequestInput & {
    providerID: string
    providerNPMs: Iterable<string>
  }

  export function resolve(input: ResolveInput): { endpoint: string; headers: Record<string, string> } | undefined {
    const profile = discoveryProfiles[input.providerID]
    if (!profile && !Array.from(input.providerNPMs).includes(OPENAI_COMPATIBLE)) {
      return undefined
    }
    const resolved = prepareRequest({
      ...input,
      apiKeyHeader: profile?.apiKeyHeader,
      catalogBaseURL: profile?.baseURL ?? input.catalogBaseURL,
      defaultHeaders: profile?.headers,
    })
    if (!resolved) return undefined
    return {
      endpoint: endpoint(resolved.baseURL),
      headers: resolved.headers,
    }
  }

  // Resolve the base URL and request headers for the /models call. Base URL precedence: config
  // endpoint, then config baseURL, then the catalog entry — so a connected provider like Kilo Gateway
  // works untouched. Returns undefined when no base URL is known. Adds a Bearer header from the key
  // unless the config already carries an explicit authentication header.
  export function request(input: RequestInput): { baseURL: string; headers: Record<string, string> } | undefined {
    return prepareRequest(input)
  }

  function prepareRequest(
    input: ProfileRequestInput,
  ): { baseURL: string; headers: Record<string, string> } | undefined {
    const options = input.configOptions
    const baseURL = (options?.endpoint ?? options?.baseURL ?? input.catalogBaseURL ?? "").trim()
    if (!baseURL) return undefined

    const headers: Record<string, string> = { ...input.defaultHeaders }
    if (options?.headers) {
      for (const [key, value] of Object.entries(options.headers)) {
        if (typeof value === "string") headers[key] = value
      }
    }
    const key = input.authKey ?? (typeof options?.apiKey === "string" ? options.apiKey : undefined)
    const hasAuthHeader = Object.keys(headers).some((header) =>
      ["authorization", "x-api-key"].includes(header.toLowerCase()),
    )
    if (key && !hasAuthHeader) {
      if (input.apiKeyHeader === "x-api-key") headers["X-Api-Key"] = key
      else headers["Authorization"] = `Bearer ${key}`
    }
    return { baseURL, headers }
  }
}
