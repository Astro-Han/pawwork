import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, test, vi } from "vitest"
import { load } from "js-yaml"
import {
  PAWWORK_SEARCH_PROVIDER_ID,
  PawWorkSearchProvider,
  inject,
  name,
} from "../../resources/dsh/web-search/lib/index.js"

const patchFile = resolve(
  import.meta.dirname,
  "../../resources/dsh/home/product.cordis.patch.yml",
)

type PatchRow = {
  id?: string
  config?: Record<string, unknown>
  insert?: Array<{ id: string; name: string }>
}

function readProductPatch() {
  return load(readFileSync(patchFile, "utf8")) as PatchRow[]
}

/** One SSE-framed JSON-RPC answer carrying Exa's rendered report. */
function exaResponse(text: string, extra: Record<string, unknown> = {}) {
  return new Response(`data: ${JSON.stringify({ result: { content: [{ type: "text", text }], ...extra } })}\n\n`, {
    status: 200,
  })
}

describe("PawWork DSH web search plugin", () => {
  test("registers into the web seam as one provider", () => {
    expect(name).toBe("pawwork-web-search")
    expect(inject).toEqual(["web"])
    expect(PAWWORK_SEARCH_PROVIDER_ID).toBe("pawwork")
  })

  // Two halves: the plugin registers the id, and the profile selects it. Either
  // one alone leaves a first-run user's search failing on a missing vendor key,
  // and they sit in different files, so nothing but this couples them.
  test("the profile mounts the plugin and points the seam at it", () => {
    const patch = readProductPatch()
    const inserted = patch.flatMap((row) => row.insert ?? [])

    expect(inserted).toContainEqual({ id: "pawwork-web-search", name: "@pawwork/dsh-web-search" })
    expect(patch.find((row) => row.id === "web")?.config?.searchProvider).toBe(PAWWORK_SEARCH_PROVIDER_ID)
  })

  // `available()` must stay a cheap local check that makes no network call, so
  // it cannot consult a credential — and this backend has none to consult.
  test("stays selectable so the seam never reports the provider as absent", () => {
    expect(new PawWorkSearchProvider().available()).toBe(true)
  })

  // The one promise the product makes: a fresh install searches before anyone
  // configures a key. A request that grew a credential parameter would be
  // scoped to a key nobody has.
  test("searches anonymously through Exa's free allowance", async () => {
    const requests: Array<{ url: string; body: { params: { arguments: Record<string, unknown> } } }> = []
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init.body)) })
      return exaResponse("Title: T\nURL: https://e.com/\nPublished: N/A\nAuthor: N/A\nHighlights:\nA line.")
    })

    const result = await new PawWorkSearchProvider().search({ query: "anything", maxResults: 2 })
    vi.unstubAllGlobals()

    expect(requests[0].url).toBe("https://mcp.exa.ai/mcp")
    expect(requests[0].body.params.arguments).toEqual({ query: "anything", numResults: 2 })
    // Exa renders a missing date as the literal "N/A"; passing that through
    // would put a fake timestamp in front of the model.
    expect(result.sources).toEqual([{ url: "https://e.com/", title: "T", snippet: "A line." }])
  })

  // A spent shared allowance is the failure this backend actually has, and the
  // fix is the user's own key. Reporting it as a generic provider error would
  // send them looking for a broken plugin instead.
  test("names a spent allowance as a missing credential", async () => {
    vi.stubGlobal("fetch", async () => exaResponse("Rate limit exceeded", { isError: true }))

    await expect(new PawWorkSearchProvider().search({ query: "anything" })).rejects.toMatchObject({
      code: "WEB_PROVIDER_CREDENTIAL_MISSING",
    })
    vi.unstubAllGlobals()
  })

  // The seam's own error type is what carries a code downstream; a bare Error
  // would reach the tool layer as an unclassified internal failure.
  test("reports a transport failure in the seam's vocabulary", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("connection refused")
    })

    await expect(new PawWorkSearchProvider().search({ query: "anything" })).rejects.toMatchObject({
      code: "WEB_PROVIDER_ERROR",
    })
    vi.unstubAllGlobals()
  })

  // The caller's abort and this module's own deadline both surface as the same
  // AbortError, and only the caller's is the seam's `WEB_ABORTED`.
  test("distinguishes the caller's abort from its own deadline", async () => {
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      throw Object.assign(new Error("aborted"), { name: "AbortError", cause: init.signal })
    })
    const controller = new AbortController()
    controller.abort()

    await expect(
      new PawWorkSearchProvider().search({ query: "anything" }, controller.signal),
    ).rejects.toMatchObject({ code: "WEB_ABORTED" })
    vi.unstubAllGlobals()
  })
})
