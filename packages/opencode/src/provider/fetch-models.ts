import { z } from "zod"

// Discover model IDs from an OpenAI-compatible provider/gateway `/models` endpoint.
// Mirrors the fetch+parse precedent in plugin/github-copilot/models.ts, but stays
// generic: we only keep id + display name, never infer capabilities from arbitrary
// gateway IDs (wrong metadata would break agent behavior — see issue #1463).
export namespace FetchModels {
  const Item = z.object({ id: z.string(), name: z.string().optional() })
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
      result.push({ id, name: item.data.name?.trim() || id })
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

  // Resolve the base URL and request headers for the /models call. Base URL precedence: config
  // endpoint, then config baseURL, then the catalog entry — so a connected provider like Kilo Gateway
  // works untouched. Returns undefined when no base URL is known. Adds a Bearer header from the key
  // unless the config already carries an explicit Authorization header.
  export function request(input: RequestInput): { baseURL: string; headers: Record<string, string> } | undefined {
    const options = input.configOptions
    const baseURL = (options?.endpoint ?? options?.baseURL ?? input.catalogBaseURL ?? "").trim()
    if (!baseURL) return undefined

    const headers: Record<string, string> = {}
    if (options?.headers) {
      for (const [key, value] of Object.entries(options.headers)) {
        if (typeof value === "string") headers[key] = value
      }
    }
    const key = input.authKey ?? (typeof options?.apiKey === "string" ? options.apiKey : undefined)
    if (key && !Object.keys(headers).some((header) => header.toLowerCase() === "authorization")) {
      headers["Authorization"] = `Bearer ${key}`
    }
    return { baseURL, headers }
  }
}
