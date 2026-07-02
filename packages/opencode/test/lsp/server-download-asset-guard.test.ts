import { afterEach, expect, test } from "bun:test"
import { Log } from "@opencode-ai/core/util/log"
import { LSPServer } from "../../src/lsp/server"

void Log.init({ print: false })

const originalFetch = globalThis.fetch
const originalPath = process.env.PATH

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
})

// Regression for the unguarded `release.assets.find` in the LSP download paths
// (mirrors upstream opencode #22882, thanks @kitlangton). A malformed GitHub
// release body with no `assets` array must not crash spawn with a TypeError — it
// should log and bail, the way the clangd / texlab / tinymist guards already do.
//
// LuaLS.spawn is the cleanest way to exercise the shared guard: it needs no
// prerequisite binary, just an absent `lua-language-server` (true in CI) and a
// fetch that returns an asset-less release. Zls.spawn carries the identical guard.
test("LuaLS.spawn tolerates a GitHub release without an assets array", async () => {
  // Hermetic: an empty PATH means `which("lua-language-server")` only looks in
  // Global.Path.bin (never the runner image), so it reliably finds nothing and
  // spawn always takes the download path instead of launching a preinstalled LSP.
  process.env.PATH = ""

  let fetched = false
  globalThis.fetch = (async () => {
    fetched = true
    // No `assets` field — the pre-fix `release.assets.find(...)` threw a TypeError here.
    return new Response(JSON.stringify({ tag_name: "3.0.0" }), { status: 200 })
  }) as unknown as typeof fetch

  // On every platform combo CI runs (linux-x64 / win32-x64 / darwin-arm64) spawn
  // reaches the asset lookup; an unsupported combo would bail one step earlier at
  // the supported-combos check, so the assertion targets "resolves, no TypeError".
  await expect(LSPServer.LuaLS.spawn(process.cwd())).resolves.toBeUndefined()
  // Guard against a false green: prove spawn actually entered the download/parse
  // path (and thus the asset lookup) rather than short-circuiting before it.
  expect(fetched).toBe(true)
})
