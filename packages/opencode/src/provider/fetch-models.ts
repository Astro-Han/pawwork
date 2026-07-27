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
    baseURLAliases?: Record<string, string>
    defaultBaseURL?: string
    headers?: Record<string, string>
    query?: Record<string, string>
  }
  const minimaxGlobal: DiscoveryProfile = {
    baseURLAliases: { "https://api.minimax.io/anthropic/v1": "https://api.minimax.io/v1" },
  }
  const minimaxChina: DiscoveryProfile = {
    baseURLAliases: { "https://api.minimaxi.com/anthropic/v1": "https://api.minimaxi.com/v1" },
  }
  const discoveryProfiles: Record<string, DiscoveryProfile> = {
    anthropic: {
      apiKeyHeader: "x-api-key",
      defaultBaseURL: "https://api.anthropic.com/v1",
      headers: { "anthropic-version": "2023-06-01" },
      query: { limit: "1000" },
    },
    freemodel: {},
    "kimi-for-coding": {},
    minimax: minimaxGlobal,
    "minimax-coding-plan": minimaxGlobal,
    "minimax-cn": minimaxChina,
    "minimax-cn-coding-plan": minimaxChina,
    openai: { defaultBaseURL: "https://api.openai.com/v1" },
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

  function endpoint(baseURL: string, query?: Record<string, string>): string {
    const url = `${baseURL.trim().replace(/\/+$/, "")}/models`
    const params = new URLSearchParams(query).toString()
    return params ? `${url}?${params}` : url
  }

  type ResolveOptions = {
    // Provider config `options` (user override): endpoint/baseURL/apiKey/headers.
    configOptions?: {
      endpoint?: string
      baseURL?: string
      apiKey?: string
      headers?: Record<string, unknown>
    }
    // API key from the auth store (preferred over a config-embedded apiKey).
    authKey?: string
    // Resolved provider API for providers whose discovery follows their inference base.
    providerBaseURL?: string
    // models.dev catalog base URL, used when the user has not overridden one.
    catalogBaseURL?: string
  }

  export type ResolveInput = ResolveOptions & {
    providerID: string
    providerNPMs: Iterable<string>
  }

  export function resolve(input: ResolveInput): { endpoint: string; headers: Record<string, string> } | undefined {
    const profile = discoveryProfiles[input.providerID]
    if (!profile && !Array.from(input.providerNPMs).includes(OPENAI_COMPATIBLE)) {
      return undefined
    }
    const resolved = prepareRequest(input, profile)
    if (!resolved) return undefined
    return {
      endpoint: endpoint(resolved.baseURL, profile?.query),
      headers: resolved.headers,
    }
  }

  function prepareRequest(
    input: ResolveOptions,
    profile: DiscoveryProfile | undefined,
  ): { baseURL: string; headers: Record<string, string> } | undefined {
    const options = input.configOptions
    const inferredBaseURL =
      options?.baseURL ?? input.providerBaseURL ?? input.catalogBaseURL ?? profile?.defaultBaseURL ?? ""
    const normalizedBaseURL = inferredBaseURL.trim().replace(/\/+$/, "")
    const baseURL = (options?.endpoint ?? profile?.baseURLAliases?.[normalizedBaseURL] ?? inferredBaseURL).trim()
    if (!baseURL || baseURL.includes("${") || !URL.canParse(baseURL)) return undefined

    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(profile?.headers ?? {})) {
      setHeader(headers, key, value)
    }
    if (options?.headers) {
      for (const [key, value] of Object.entries(options.headers)) {
        if (typeof value === "string") setHeader(headers, key, value)
      }
    }
    const key = input.authKey ?? (typeof options?.apiKey === "string" ? options.apiKey : undefined)
    const authHeader = profile?.apiKeyHeader === "x-api-key" ? "x-api-key" : "authorization"
    const hasAuthHeader = Object.keys(headers).some((header) => header.toLowerCase() === authHeader)
    if (key && !hasAuthHeader) {
      if (profile?.apiKeyHeader === "x-api-key") headers["X-Api-Key"] = key
      else headers["Authorization"] = `Bearer ${key}`
    }
    return { baseURL, headers }
  }

  function setHeader(headers: Record<string, string>, key: string, value: string) {
    const existing = Object.keys(headers).find((header) => header.toLowerCase() === key.toLowerCase())
    if (existing) delete headers[existing]
    headers[key] = value
  }
}
