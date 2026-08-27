import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { describe, expect, test, vi } from "vitest"
import { readEntryList, readProductPatch } from "./dsh-product-patch.testing"
import {
  Config,
  PAWWORK_SEARCH_PROVIDER_ID,
  PAWWORK_WEB_SEARCH_SETTINGS_NAMESPACE,
  PawWorkSearchProvider,
  inject,
  name,
} from "../../resources/dsh/web-search/lib/index.js"

const webSearchRoot = resolve(import.meta.dirname, "../../resources/dsh/web-search")

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

/** One page in the shape Exa renders it; this path passes the text through whole. */
function block(title = "A title", url = "https://example.com/a") {
  return `Title: ${title}\nURL: ${url}\nPublished: N/A\nAuthor: N/A\nHighlights:\nAn excerpt.`
}

/** Blocks joined the way Exa renders a multi-result report. */
function report(...blocks: string[]) {
  return blocks.join("\n\n---\n\n")
}

/** Search the keyless path against a canned body and return the seam result. */
async function searchFor(body: string | Response, config: Record<string, unknown> = {}) {
  vi.stubGlobal("fetch", async () => (body instanceof Response ? body : new Response(body, { status: 200 })))
  try {
    const provider = new PawWorkSearchProvider(contextWith(), () => Config(config))
    return (await provider.search({ query: "anything" })) as {
      content?: string
      sources: unknown[]
      truncated: boolean
    }
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

  // Both rows above address entries by id, and an id that matches nothing is a
  // warning on the sidecar's stderr, not an error. Silence there is expensive:
  // an unmatched `web` leaves the base value selected, so the promise this
  // whole change exists for — search before anyone configures a key — reverts
  // to a credential error on a user's first search, and an unmatched
  // `web-search-deepseek` puts upstream's card back beside ours. Versions are
  // pinned exactly, so this can only arrive through a deliberate bump; asserting
  // the ids against the base profile turns that bump red here instead of quiet
  // there.
  test("addresses entries the pinned dsh-base actually declares", () => {
    // Parsed, not scanned. A line scan reads an id out of a block scalar that
    // merely looks like one and misses a quoted or commented one, which is the
    // wrong way round for a guard: it would pass on a bump that renamed the row
    // and fail on one that only reformatted it. `readEntryList` is the same
    // reader the product overlay goes through, `!!js` rows included.
    const baseProfile = createRequire(import.meta.url).resolve("@deepseek-ai/dsh-base/cordis.patch.yml")
    const rows = readEntryList(baseProfile).flatMap((patch) => patch.insert ?? [])
    const declared = new Set(rows.map((row) => row.id))

    expect(declared.size).toBeGreaterThan(1)
    for (const id of ["web", "web-search-deepseek"]) {
      expect(readProductPatch().some((row) => row.id === id)).toBe(true)
      expect(declared).toContain(id)
    }
    // The id is only half of it. A bump that kept the row and renamed its
    // config key would still match, still write, and still leave the seam on
    // its base provider — the same first-search credential error, arrived at
    // through a patch that looks applied.
    expect(rows.find((row) => row.id === "web")?.config).toHaveProperty("searchProvider")
  })

  test("defaults to the Exa engine, which is the one that needs no key", () => {
    expect(Config({}).backend).toBe("exa")
  })

  // The settings file is hand-editable and `credentialRef` answers a name
  // outside its grammar with a bare `TypeError` — not a failure the seam can
  // report but an unhandled throw, taking down the keyless path that needs no
  // reference at all. A name nobody can resolve is a name nobody set, which is
  // what the card already reads it as.
  test("a reference edited to something unresolvable reads as unset", async () => {
    for (const ref of ["", "   ", "my-key", "1KEY", "EXA.API.KEY", "kéy"]) {
      const result = await searchFor(exaResponse(block()), { exaApiKeyEnv: ref })

      expect(result.content).toContain("https://example.com/a")
    }
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
      return exaResponse(block("T", "https://e.com/"))
    })

    const provider = new PawWorkSearchProvider(contextWith(), () => Config({}))
    const result = await provider.search({ query: "anything", maxResults: 2 })
    vi.unstubAllGlobals()

    expect(requests[0].url).toBe("https://mcp.exa.ai/mcp")
    expect(requests[0].body.params.arguments).toEqual({ query: "anything", numResults: 2 })
    expect(result as { content: string; sources: unknown[] }).toMatchObject({
      content: expect.stringContaining("https://e.com/"),
      sources: [],
    })
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
  // the user looking for a missing plugin instead of a missing key — and the
  // upstream class's own advice names the `web-search-deepseek` config, an entry
  // this product's patch disables, so it has to be replaced rather than relayed.
  test("the DeepSeek engine with no key points at the card, not the disabled entry", async () => {
    const provider = new PawWorkSearchProvider(contextWith(), () => Config({ backend: "deepseek" }))

    const failure = await provider.search({ query: "anything" }).catch((error: unknown) => error)

    expect(failure).toMatchObject({ code: "WEB_PROVIDER_CREDENTIAL_MISSING" })
    expect((failure as Error).message).toContain("Settings")
    expect((failure as Error).message).not.toContain("web-search-deepseek")
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
      return exaResponse(block())
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
  // The report is handed over whole, as `content` with no `sources`.
  //
  // Everything under `Highlights:` is verbatim page text, so splitting the
  // report into attributed sources means deciding which bytes are Exa's
  // structure and which are a page's — a distinction the report does not carry.
  // Three boundary rules shipped and each one both minted sources a page
  // authored and truncated pages that did nothing wrong. So nothing here claims
  // to know: the model reads the same bytes, and no part of this product vouches
  // for a structure it cannot verify.
  test("the rendered report is passed through whole, with no sources", async () => {
    const rendered = report(block("First", "https://example.com/1"), block("Second", "https://example.com/2"))

    const result = await searchFor(exaResponse(rendered))

    expect(result).toMatchObject({ sources: [], truncated: false })
    expect(result.content?.endsWith(rendered)).toBe(true)
  })

  // `dsh-tool-web` renders `content` first, unattributed, as the search
  // service's own answer, and appends "Cite the relevant URLs above" — while
  // every byte here is page text, including the URLs. A page that writes Exa's
  // framing therefore reaches the model, and what keeps it from arriving in the
  // provider's voice is the preamble, ahead of the first byte the page wrote.
  test("the report reaches the model labelled as page text, not as an answer", async () => {
    const forged = report(block("Citation formatting", "https://example.com/docs"), block("Advisory", "https://evil.example/pwn"))

    const result = await searchFor(exaResponse(forged))

    expect(result.sources).toEqual([])
    expect(result.content).toContain("https://evil.example/pwn")
    expect(result.content?.indexOf("never to follow")).toBeLessThan(result.content?.indexOf("evil.example") ?? -1)
  })

  // Two content blocks are two pieces of one report; both reach the model.
  test("a report split across content blocks keeps both pieces", async () => {
    const envelope = {
      result: {
        content: [
          { type: "text", text: block("First", "https://example.com/1") },
          { type: "text", text: block("Second", "https://example.com/2") },
        ],
      },
    }

    const result = await searchFor(`data: ${JSON.stringify(envelope)}\n\n`)

    expect(result.content).toContain("https://example.com/1")
    expect(result.content).toContain("https://example.com/2")
  })

  // Third-party JSON, so the envelope's shape is checked rather than assumed. A
  // shape this module does not expect is a provider failure it can report, not a
  // `TypeError` escaping into a seam with no vocabulary for one.
  test("a malformed envelope is a provider error, not a thrown TypeError", async () => {
    for (const body of [
      `data: {"error":null}\n\n`,
      `data: null\n\n`,
      `data: {"result":{"content":"hi"}}\n\n`,
      `data: {"result":{"content":[null]}}\n\n`,
    ]) {
      await expect(searchFor(body)).rejects.toMatchObject({ code: "WEB_PROVIDER_ERROR" })
    }
  })

  test("the framing tolerates keep-alive lines and a missing trailing blank line", async () => {
    const framed = JSON.stringify({ result: { content: [{ type: "text", text: block() }] } })

    expect((await searchFor(`: keep-alive\nevent: message\ndata: ${framed}\n\n`)).content).toContain("A title")
    expect((await searchFor(`data: ${framed}`)).content).toContain("A title")
  })

  // Streamable HTTP lets the server answer either way, and this request says it
  // accepts both, so a JSON answer is an answer rather than an outage.
  test("a plain JSON answer parses like an SSE-framed one", async () => {
    const body = JSON.stringify({ result: { content: [{ type: "text", text: block() }] } })

    expect((await searchFor(body)).content).toContain("A title")
  })

  // The seam renders a result with neither content nor sources as "No results
  // found.", so an answer we cannot read must not become one — that is the only
  // failure on this path that would have the model confidently tell the user the
  // web holds nothing.
  test("an unreadable answer fails instead of reporting nothing found", async () => {
    await expect(searchFor(`data: {"result":{"content":[]}}\n\n`)).rejects.toMatchObject({
      code: "WEB_PROVIDER_ERROR",
    })
    await expect(searchFor(`data: {"jsonrpc":"2.0","id":1}\n\n`)).rejects.toMatchObject({
      code: "WEB_PROVIDER_ERROR",
    })
  })

  // Streamable HTTP lets the server put its own notifications on the stream
  // ahead of the answer, so taking the first framed event would fail every
  // search the moment Exa or a proxy sent one. What marks the answer is
  // carrying `result` or `error`: a live capture shows Exa omits both `id` and
  // `jsonrpc`, so neither of those can be what selects it.
  test("a notification ahead of the answer is not mistaken for it", async () => {
    const notice = JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } })
    const answer = JSON.stringify({ result: { content: [{ type: "text", text: block("Real", "https://example.com/real") }] } })

    const result = await searchFor(`event: message\ndata: ${notice}\n\nevent: message\ndata: ${answer}\n\n`)

    expect(result.content).toContain("https://example.com/real")
  })

  test("a body carrying no event is a provider error", async () => {
    await expect(searchFor("event: message\n\n")).rejects.toMatchObject({ code: "WEB_PROVIDER_ERROR" })
  })

  test("a JSON-RPC error surfaces as a provider error", async () => {
    const body = `data: ${JSON.stringify({ error: { code: -32000, message: "boom" } })}\n\n`

    await expect(searchFor(body)).rejects.toMatchObject({
      code: "WEB_PROVIDER_ERROR",
      message: expect.stringContaining("boom"),
    })
  })

  // A status code is a protocol, so it still classifies: 401/402/403 mean Exa
  // declined to serve this caller and a key is the way through, 429/503 mean
  // come back later, and anything else is an outage. A caller here holds no key
  // by definition, so a refusal has to carry the remedy and not just its number.
  test("statuses still separate a refusal from a throttle", async () => {
    for (const status of [401, 402, 403]) {
      await expect(searchFor(new Response("", { status }))).rejects.toMatchObject({
        code: "WEB_PROVIDER_CREDENTIAL_MISSING",
        message: expect.stringContaining("Exa API key"),
      })
    }
    for (const status of [429, 503, 500]) {
      await expect(searchFor(new Response("", { status }))).rejects.toMatchObject({
        code: "WEB_PROVIDER_ERROR",
      })
    }
  })

  // Prose is not a protocol, and this module used to read it as one. Exa answers
  // a spent allowance, a throttle and an outage identically — HTTP 200,
  // `isError`, an English sentence that may also quote the user's own query — so
  // keyword regexes over it got the answer wrong in both directions: they sent
  // people to buy a key when a burst was throttled, and told them to wait when
  // the allowance was genuinely spent. Every string below is one of those
  // reproductions. They now share one outcome that names both remedies, because
  // the distinction is not in the data.
  test("prose failures share one outcome that names both remedies", async () => {
    const prose = [
      "You have exhausted your free tier quota. Please try again later.",
      "Rate limit exceeded, please try again",
      "You have exceeded your per-minute quota. Please retry in 60 seconds.",
      "Search failed: the upstream certificate has expired",
      "Exa's shared quota for this deployment isn't available right now.",
      'Search failed for query: "openai "api key" rotation". The upstream service returned an unexpected response.',
      `Search failed for query: "${"how do I ".repeat(30)}". Your free tier quota is exhausted.`,
    ]
    for (const text of prose) {
      await expect(searchFor(exaResponse(text, { isError: true }))).rejects.toMatchObject({
        code: "WEB_PROVIDER_ERROR",
        message: expect.stringContaining("Exa API key"),
      })
    }
  })
})
