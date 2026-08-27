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

const repositoryRoot = resolve(import.meta.dirname, "../../../..")
const webSearchRoot = resolve(repositoryRoot, "packages/desktop-electron/resources/dsh/web-search")
const patchFile = resolve(repositoryRoot, "packages/desktop-electron/resources/dsh/home/product.cordis.patch.yml")

type PatchRow = { id?: string; disabled?: boolean; config?: Record<string, unknown>; insert?: Array<{ id: string; name: string }> }

function patchRows() {
  return load(readFileSync(patchFile, "utf8")) as PatchRow[]
}

/** A context exposing only the planes the provider reads. */
function fakeContext(options: { credential?: string; credentials?: boolean } = {}) {
  return {
    get: (service: string) => {
      if (service !== "credentials") return undefined
      if (options.credentials === false) return undefined
      return { resolve: async () => (options.credential === undefined ? undefined : { value: options.credential }) }
    },
  }
}

describe("PawWork DSH web search plugin", () => {
  test("declares one packaged DSH plugin with a browser half", () => {
    const manifest = JSON.parse(readFileSync(resolve(webSearchRoot, "package.json"), "utf8"))

    expect(manifest.name).toBe("@pawwork/dsh-web-search")
    expect(manifest.main).toBe("./lib/index.js")
    expect(manifest.exports["./client"].default).toBe("./lib/client.js")
    expect(manifest.dsh.client.platform).toBe("web")
  })

  test("registers into the web seam as one provider", () => {
    expect(name).toBe("pawwork-web-search")
    expect(inject).toEqual(["web"])
    expect(PAWWORK_SEARCH_PROVIDER_ID).toBe("pawwork")
  })

  // The seam resolves `searchProvider` once, at construction. Naming a vendor id
  // here would make the settings choice unreachable without a restart, and the
  // profile would disagree with whatever the card last wrote.
  test("the profile points the seam at this provider, not at a vendor", () => {
    const web = patchRows().find((row) => row.id === "web")

    expect(web?.config?.searchProvider).toBe(PAWWORK_SEARCH_PROVIDER_ID)
  })

  // Two registered providers that both edit "web search" would show two cards
  // that disagree, and dsh-base's DeepSeek mount fails on the first search for
  // the OpenCode Free users who are PawWork's default.
  test("the standalone DeepSeek search mount is disabled in favour of this one", () => {
    const deepseek = patchRows().find((row) => row.id === "web-search-deepseek")

    expect(deepseek?.disabled).toBe(true)
  })

  test("the profile mounts the plugin", () => {
    const inserted = patchRows().flatMap((row) => row.insert ?? [])

    expect(inserted).toContainEqual({ id: "pawwork-web-search", name: "@pawwork/dsh-web-search" })
  })

  test("defaults to the Exa backend", () => {
    expect(Config({}).backend).toBe("exa")
    expect(PAWWORK_WEB_SEARCH_SETTINGS_NAMESPACE).toBe("pawwork-web-search")
  })

  test("keeps every vendor key out of the settings document", () => {
    const serialized = JSON.stringify(Config.toJSON())

    for (const field of ["exaApiKey", "perplexityApiKey", "deepseekApiKey"]) {
      expect(serialized).toContain(field)
    }
    expect(Config.dict?.exaApiKey.meta.role).toBe("secret")
    expect(Config.dict?.perplexityApiKey.meta.role).toBe("secret")
    expect(Config.dict?.deepseekApiKey.meta.role).toBe("secret")
  })

  // Selection happens per search, not at registration: a user who switches the
  // backend in settings must reach the new one on the next search.
  test("reads the backend on every search rather than at registration", async () => {
    let backend: "exa" | "deepseek" | "perplexity" = "exa"
    const fetches: string[] = []
    vi.stubGlobal("fetch", async (url: string) => {
      fetches.push(String(url))
      return new Response(`data: {"result":{"content":[{"type":"text","text":""}]}}\n\n`, { status: 200 })
    })
    const provider = new PawWorkSearchProvider(fakeContext(), () => Config({ backend }))

    await provider.search({ query: "a" })
    backend = "perplexity"
    await provider.search({ query: "b" }).catch(() => {})
    vi.unstubAllGlobals()

    expect(fetches).toHaveLength(1)
    expect(fetches[0]).toContain("mcp.exa.ai")
  })

  // The one promise the product makes that the section cannot: a fresh install
  // searches before anyone configures a key.
  test("searches through Exa's free allowance when no key is held", async () => {
    const requests: Array<{ url: string; body: unknown }> = []
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init.body)) })
      return new Response(
        `data: {"result":{"content":[{"type":"text","text":"Title: T\\nURL: https://e.com/\\nPublished: N/A\\nAuthor: N/A\\nHighlights:\\nA line."}]}}\n\n`,
        { status: 200 },
      )
    })
    const provider = new PawWorkSearchProvider(fakeContext(), () => Config({}))

    const result = await provider.search({ query: "anything", maxResults: 2 })
    vi.unstubAllGlobals()

    expect(requests[0].url).toBe("https://mcp.exa.ai/mcp")
    expect(result.sources).toEqual([{ url: "https://e.com/", title: "T", snippet: "A line." }])
  })

  test("a held Exa key routes to Exa's own search endpoint", async () => {
    const requests: string[] = []
    vi.stubGlobal("fetch", async (url: string) => {
      requests.push(String(url))
      return new Response(JSON.stringify({ results: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })
    const provider = new PawWorkSearchProvider(fakeContext({ credential: "a-key" }), () => Config({}))

    await provider.search({ query: "anything" })
    vi.unstubAllGlobals()

    expect(requests[0]).toBe("https://api.exa.ai/search")
  })

  // Exa is keyless; the other two are not. Reporting that as "no provider" would
  // send the user looking for a missing plugin instead of a missing key.
  test("a keyed backend with no key names the missing credential", async () => {
    const provider = new PawWorkSearchProvider(fakeContext(), () => Config({ backend: "perplexity" }))

    await expect(provider.search({ query: "anything" })).rejects.toMatchObject({
      code: "WEB_PROVIDER_CREDENTIAL_MISSING",
    })
  })

  // `available()` must stay a cheap local check that makes no network call, and
  // the credentials seam answers asynchronously — so it cannot consult a key.
  test("stays selectable so the seam never reports the provider as absent", () => {
    expect(new PawWorkSearchProvider(fakeContext(), () => Config({})).available()).toBe(true)
    expect(new PawWorkSearchProvider(fakeContext(), () => Config({ backend: "deepseek" })).available()).toBe(true)
  })

  // Keys live in the credentials domain, which is what the settings card writes
  // and what the Models page rotates; the launch environment is only the
  // fallback for a deployment without that service.
  test("prefers the credentials service over the launch environment", async () => {
    const requests: string[] = []
    vi.stubGlobal("fetch", async (url: string) => {
      requests.push(String(url))
      return new Response(`data: {"result":{"content":[{"type":"text","text":""}]}}\n\n`, { status: 200 })
    })
    const provider = new PawWorkSearchProvider(
      fakeContext({ credentials: true, credential: undefined }),
      () => Config({}),
    )

    await provider.search({ query: "anything" })
    vi.unstubAllGlobals()

    // The service answered "no key held", so the search stays anonymous even
    // though the process environment might carry one.
    expect(requests[0]).toContain("mcp.exa.ai")
  })
})
