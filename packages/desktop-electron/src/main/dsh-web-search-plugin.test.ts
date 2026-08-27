import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, test, vi } from "vitest"
import { load } from "js-yaml"
import {
  Config,
  PAWWORK_SEARCH_PROVIDER_ID,
  PAWWORK_WEB_SEARCH_SETTINGS_NAMESPACE,
  PawWorkSearchProvider,
  inject,
  name,
} from "../../resources/dsh/web-search/lib/index.js"

const webSearchRoot = resolve(import.meta.dirname, "../../resources/dsh/web-search")
const patchFile = resolve(import.meta.dirname, "../../resources/dsh/home/product.cordis.patch.yml")

type PatchRow = {
  id?: string
  disabled?: boolean
  config?: Record<string, unknown>
  insert?: Array<{ id: string; name: string }>
}

function readProductPatch() {
  return load(readFileSync(patchFile, "utf8")) as PatchRow[]
}

/** A context exposing only the plane the provider reads: the credentials service. */
function contextWith(credential?: string) {
  return {
    get: (service: string) =>
      service === "credentials"
        ? { resolve: async () => (credential === undefined ? undefined : { value: credential }) }
        : undefined,
  }
}

/** One SSE-framed JSON-RPC answer carrying Exa's rendered report. */
function exaResponse(text: string, extra: Record<string, unknown> = {}) {
  const envelope = { result: { content: [{ type: "text", text }], ...extra } }
  return new Response(`event: message\ndata: ${JSON.stringify(envelope)}\n\n`, { status: 200 })
}

/** A report block in Exa's rendered shape. */
function block(fields: { title?: string; url?: string; published?: string; highlights?: string[] } = {}) {
  const { title = "A title", url = "https://example.com/a", published = "N/A", highlights = ["An excerpt."] } = fields
  return [`Title: ${title}`, `URL: ${url}`, `Published: ${published}`, "Author: N/A", "Highlights:", ...highlights].join("\n")
}

/** Search the keyless path against a canned body and return the sources. */
async function sourcesFor(body: string | Response) {
  vi.stubGlobal("fetch", async () => (body instanceof Response ? body : new Response(body, { status: 200 })))
  try {
    const provider = new PawWorkSearchProvider(contextWith(), () => Config({}))
    const result = await provider.search({ query: "anything" })
    return (result as { sources: unknown[] }).sources
  } finally {
    vi.unstubAllGlobals()
  }
}

describe("PawWork DSH web search plugin", () => {
  test("registers into the web seam as one provider", () => {
    expect(name).toBe("pawwork-web-search")
    expect(inject).toEqual(["web"])
    expect(PAWWORK_SEARCH_PROVIDER_ID).toBe("pawwork")
    expect(PAWWORK_WEB_SEARCH_SETTINGS_NAMESPACE).toBe("pawwork-web-search")
  })

  // Three halves, in three files, and any one alone is a broken product: the
  // profile selects an id nothing registers, or a provider nothing selects, or
  // a settings section with no card — and a Host namespace no card claims
  // renders nothing, so the section would exist with no way for a user to reach
  // it. Nothing but this couples them.
  test("mounts the plugin, points the seam at it, and ships the card that edits it", () => {
    const patch = readProductPatch()
    const manifest = JSON.parse(readFileSync(resolve(webSearchRoot, "package.json"), "utf8"))

    expect(patch.flatMap((row) => row.insert ?? [])).toContainEqual({
      id: "pawwork-web-search",
      name: "@pawwork/dsh-web-search",
    })
    expect(patch.find((row) => row.id === "web")?.config?.searchProvider).toBe(PAWWORK_SEARCH_PROVIDER_ID)
    expect(manifest.exports["./client"].default).toBe("./lib/client.js")
    expect(manifest.dsh.client.platform).toBe("web")
  })

  // Our card constructs the same DeepSeek backend against the same credential
  // reference, so leaving upstream's row mounted would put a second card titled
  // "web search" next to ours, editing a provider the seam will never select.
  test("displaces the upstream DeepSeek row rather than sitting beside it", () => {
    expect(readProductPatch().find((row) => row.id === "web-search-deepseek")?.disabled).toBe(true)
  })

  test("defaults to the Exa engine, which is the one that needs no key", () => {
    expect(Config({}).backend).toBe("exa")
  })

  // A key is a secret; the section carries only the reference that names it, so
  // the settings document never holds one.
  test("keeps keys out of the settings document", () => {
    const serialized = JSON.stringify(Config.toJSON())

    expect(serialized).not.toContain("apiKey\"")
    expect(Config.dict?.exaApiKeyEnv.meta.role).toBe("credential-ref")
    expect(Config.dict?.deepseekApiKeyEnv.meta.role).toBe("credential-ref")
  })

  // `available()` must stay a cheap local check that makes no network call, and
  // the credentials seam answers asynchronously — so it cannot consult a key.
  test("stays selectable so the seam never reports the provider as absent", () => {
    expect(new PawWorkSearchProvider(contextWith(), () => Config({})).available()).toBe(true)
    expect(new PawWorkSearchProvider(contextWith(), () => Config({ backend: "deepseek" })).available()).toBe(true)
  })
})

describe("PawWork search engine selection", () => {
  // The product promise: a fresh install searches before anyone configures a
  // key. A request that grew a credential parameter would be scoped to a key
  // nobody has.
  test("searches Exa's shared allowance when no key is held", async () => {
    const requests: Array<{ url: string; body: { params: { arguments: Record<string, unknown> } } }> = []
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init.body)) })
      return exaResponse(block({ title: "T", url: "https://e.com/", highlights: ["A line."] }))
    })

    const provider = new PawWorkSearchProvider(contextWith(), () => Config({}))
    const result = await provider.search({ query: "anything", maxResults: 2 })
    vi.unstubAllGlobals()

    expect(requests[0].url).toBe("https://mcp.exa.ai/mcp")
    expect(requests[0].body.params.arguments).toEqual({ query: "anything", numResults: 2 })
    expect((result as { sources: unknown[] }).sources).toEqual([
      { url: "https://e.com/", title: "T", snippet: "A line." },
    ])
  })

  // The point of the card: a held Exa key moves the user off the shared
  // allowance and onto Exa's official endpoint, which returns structured
  // results rather than a rendered report.
  test("a held Exa key routes to Exa's own search endpoint", async () => {
    const requests: string[] = []
    vi.stubGlobal("fetch", async (url: string) => {
      requests.push(String(url))
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })

    await new PawWorkSearchProvider(contextWith("a-key"), () => Config({})).search({ query: "anything" })
    vi.unstubAllGlobals()

    expect(requests[0]).toBe("https://api.exa.ai/search")
  })

  // DeepSeek's value is the server-side native search tool, so the request has
  // to carry it. Sending a bare completion would be a different capability
  // wearing the same name.
  test("the DeepSeek engine asks for native web search", async () => {
    let sent: { tools?: Array<{ type: string; max_uses: number }> } | undefined
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body))
      return new Response(JSON.stringify({ content: [{ type: "web_search_tool_result", content: [] }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })

    const provider = new PawWorkSearchProvider(contextWith("a-key"), () => Config({ backend: "deepseek" }))
    await provider.search({ query: "anything" })
    vi.unstubAllGlobals()

    expect(sent?.tools?.[0].type).toBe("web_search_20250305")
    expect(sent?.tools?.[0].max_uses).toBe(5)
  })

  // Exa is keyless; DeepSeek is not. Reporting that as "no provider" would send
  // the user looking for a missing plugin instead of a missing key.
  test("the DeepSeek engine with no key names the missing credential", async () => {
    const provider = new PawWorkSearchProvider(contextWith(), () => Config({ backend: "deepseek" }))

    await expect(provider.search({ query: "anything" })).rejects.toMatchObject({
      code: "WEB_PROVIDER_CREDENTIAL_MISSING",
    })
  })

  // Exa's own prose describes a quota the user has no relationship with and
  // cannot raise. The action that resolves it has to reach them.
  test("a spent allowance names the card that fixes it", async () => {
    vi.stubGlobal("fetch", async () => exaResponse("Rate limit exceeded", { isError: true }))

    const provider = new PawWorkSearchProvider(contextWith(), () => Config({}))
    await expect(provider.search({ query: "anything" })).rejects.toMatchObject({
      code: "WEB_PROVIDER_CREDENTIAL_MISSING",
      message: expect.stringContaining("Exa API key"),
    })
    vi.unstubAllGlobals()
  })

  // The body streams after the headers resolve, so cancelling a search lands
  // on the body read as often as on the request. Both have to reach the seam
  // as `WEB_ABORTED`, or a cancelled search reads as a provider failure.
  test("an abort while the body streams still reads as an abort", async () => {
    const controller = new AbortController()
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      text: async () => {
        controller.abort()
        throw new DOMException("aborted", "AbortError")
      },
    }))

    const provider = new PawWorkSearchProvider(contextWith(), () => Config({}))
    await expect(provider.search({ query: "anything" }, controller.signal)).rejects.toMatchObject({
      code: "WEB_ABORTED",
    })
    vi.unstubAllGlobals()
  })

  // Selection happens per search, not at registration: a user who switches the
  // engine in the card must reach the new one on the next search.
  test("reads the engine on every search rather than at registration", async () => {
    let backend: "exa" | "deepseek" = "exa"
    const urls: string[] = []
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(String(url))
      return exaResponse("")
    })

    const provider = new PawWorkSearchProvider(contextWith(), () => Config({ backend }))
    await provider.search({ query: "a" })
    backend = "deepseek"
    await provider.search({ query: "b" }).catch(() => {})
    vi.unstubAllGlobals()

    // The second search never reached the network: with no DeepSeek key it
    // failed on the credential, which is the new engine answering.
    expect(urls).toEqual(["https://mcp.exa.ai/mcp"])
  })
})

describe("Exa rendered-report parsing", () => {
  test("each rendered block becomes a source", async () => {
    const sources = await sourcesFor(
      exaResponse(
        [
          block({ title: "First", url: "https://example.com/1", highlights: ["One."] }),
          block({ title: "Second", url: "https://example.com/2", published: "2026-01-02", highlights: ["Two."] }),
        ].join("\n\n"),
      ),
    )

    expect(sources).toEqual([
      { url: "https://example.com/1", title: "First", snippet: "One." },
      { url: "https://example.com/2", title: "Second", snippet: "Two.", publishedAt: "2026-01-02" },
    ])
  })

  test("Exa's rendering marks are dropped from the excerpt", async () => {
    const sources = await sourcesFor(exaResponse(block({ highlights: ["> Quoted line.", "...", "> Second line."] })))

    expect(sources[0]).toMatchObject({ snippet: "Quoted line. Second line." })
  })

  // Shape taken from a live `mcp.exa.ai` answer: Exa puts a `---` rule between
  // results, and the block split happens at the blank line before the next
  // `Title:`, so the rule lands at the tail of the preceding block. Left in, it
  // rode out on every snippet but the last. A markdown table separator is not
  // the same thing and has to survive — it is page content.
  test("drops Exa's between-result rule without touching content that looks like one", async () => {
    const report = [
      "Title: First\nURL: https://example.com/1\nPublished: N/A\nAuthor: N/A\nHighlights:\nA line.\n...\n| --- | --- |\n\n---",
      "Title: Second\nURL: https://example.com/2\nPublished: N/A\nAuthor: N/A\nHighlights:\nAnother line.",
    ].join("\n\n")

    const sources = await sourcesFor(exaResponse(report))

    expect(sources).toEqual([
      { url: "https://example.com/1", title: "First", snippet: "A line. | --- | --- |" },
      { url: "https://example.com/2", title: "Second", snippet: "Another line." },
    ])
  })

  // Exa renders a missing date as the literal "N/A"; passing that through would
  // put a fake timestamp in front of the model.
  test("a date Exa reports as unknown is omitted rather than passed through", async () => {
    const sources = await sourcesFor(exaResponse(block({ published: "N/A" })))

    expect(sources[0]).not.toHaveProperty("publishedAt")
  })

  test("a block with no URL is dropped", async () => {
    expect(await sourcesFor(exaResponse("Title: Orphan\nHighlights:\nNo link."))).toEqual([])
  })

  test("the framing tolerates keep-alive lines and a missing trailing blank line", async () => {
    expect(await sourcesFor(`: keep-alive\nevent: message\ndata: {"result":{"content":[]}}\n\n`)).toEqual([])
    expect(await sourcesFor(`data: {"result":{"content":[]}}`)).toEqual([])
  })

  test("a body carrying no event is a provider error", async () => {
    await expect(sourcesFor("event: message\n\n")).rejects.toMatchObject({ code: "WEB_PROVIDER_ERROR" })
  })

  test("a JSON-RPC error surfaces as a provider error", async () => {
    const body = `data: ${JSON.stringify({ error: { code: -32000, message: "boom" } })}\n\n`

    await expect(sourcesFor(body)).rejects.toMatchObject({
      code: "WEB_PROVIDER_ERROR",
      message: expect.stringContaining("boom"),
    })
  })

  // Exa reports a spent allowance as a status as well as as prose, and both
  // have to reach the user as the same actionable failure.
  test("a refusal status reads as a spent allowance", async () => {
    await expect(sourcesFor(new Response("", { status: 429 }))).rejects.toMatchObject({
      code: "WEB_PROVIDER_CREDENTIAL_MISSING",
    })
    await expect(sourcesFor(new Response("", { status: 500 }))).rejects.toMatchObject({
      code: "WEB_PROVIDER_ERROR",
    })
  })
})
