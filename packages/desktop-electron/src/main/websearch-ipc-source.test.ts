import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const mainIpc = readFileSync(resolve(import.meta.dir, "ipc.ts"), "utf8")
const preload = readFileSync(resolve(import.meta.dir, "../preload/index.ts"), "utf8")
const preloadTypes = readFileSync(resolve(import.meta.dir, "../preload/types.ts"), "utf8")
const envTypes = readFileSync(resolve(import.meta.dir, "env.d.ts"), "utf8")
const nodeEntry = readFileSync(resolve(import.meta.dir, "../../../opencode/src/node.ts"), "utf8")

// Slice a single ipcMain.handle body out of ipc.ts so a channel can be asserted
// against the exact service method it wires to (not just "the string appears
// somewhere in the file"). Mirrors the store-get slice in ipc-window-config.test.
function handlerBody(channel: string) {
  const start = mainIpc.indexOf(`ipcMain.handle("${channel}"`)
  expect(start).toBeGreaterThanOrEqual(0)
  const next = mainIpc.indexOf("ipcMain.handle(", start + 1)
  return next > start ? mainIpc.slice(start, next) : mainIpc.slice(start)
}

describe("websearch IPC source contract", () => {
  test("exposes Web Search runtime toggle and credential channels to the sandboxed renderer", () => {
    for (const channel of [
      "websearch-set-enabled",
      "websearch-status",
      "websearch-save-exa-key",
      "websearch-remove-exa-key",
    ]) {
      expect(mainIpc).toContain(`"${channel}"`)
      expect(preload).toContain(`"${channel}"`)
    }

    for (const method of ["setWebSearchEnabled", "webSearchStatus", "saveExaApiKey", "removeExaApiKey"]) {
      expect(preloadTypes).toContain(method)
    }
  })

  test("main process imports WebSearchAuth through the embedded server boundary", () => {
    expect(mainIpc).toContain("WebSearchAuth")
    expect(envTypes).toContain("namespace WebSearchAuth")
    expect(nodeEntry).toContain('export { WebSearchAuth } from "./tool/websearch-auth"')
  })

  test("settings toggles use the Effect Settings service instead of retired facades", () => {
    expect(mainIpc).not.toContain("Settings.setLspEnabled(")
    expect(mainIpc).not.toContain("Settings.webSearchEnabled(")
    expect(mainIpc).not.toContain("Settings.setWebSearchEnabled(")
    expect(mainIpc).toContain("AppRuntime.runPromise(Settings.Service.use")
  })

  test("no handler calls a retired top-level facade anywhere in the file", () => {
    // These namespaces became Effect services in the settings migration; the
    // top-level Promise facades no longer exist and throw "is not a function"
    // at runtime (the 2026.6.10 Settings crash). None of these strings may
    // reappear in any handler.
    for (const deadFacade of [
      "WebSearchAuth.status(",
      "WebSearchAuth.saveKey(",
      "WebSearchAuth.removeKey(",
      "LSP.shutdownAll(",
      "LSP.invalidate(",
      "ToolRegistry.invalidate(",
    ]) {
      expect(mainIpc).not.toContain(deadFacade)
    }
  })

  test("each settings IPC channel wires to its specific Effect service method", () => {
    // Per-handler, not whole-file: a channel swapped onto the wrong method
    // (e.g. websearch-save-exa-key calling auth.status()) must fail here even
    // though the wrong method's string still exists in a sibling handler.
    expect(handlerBody("websearch-status")).toContain(
      "AppRuntime.runPromise(WebSearchAuth.Service.use((auth) => auth.status()))",
    )
    expect(handlerBody("websearch-save-exa-key")).toContain(
      "AppRuntime.runPromise(WebSearchAuth.Service.use((auth) => auth.saveKey(key)))",
    )
    expect(handlerBody("websearch-remove-exa-key")).toContain(
      "AppRuntime.runPromise(WebSearchAuth.Service.use((auth) => auth.removeKey()))",
    )

    const lspHandler = handlerBody("lsp-set-enabled")
    expect(lspHandler).toContain("AppRuntime.runPromise(LSP.Service.use((lsp) => lsp.shutdownAll()))")
    expect(lspHandler).toContain("AppRuntime.runPromise(LSP.Service.use((lsp) => lsp.invalidate()))")
    expect(lspHandler).toContain("AppRuntime.runPromise(ToolRegistry.Service.use((registry) => registry.invalidate()))")

    expect(handlerBody("websearch-set-enabled")).toContain(
      "AppRuntime.runPromise(ToolRegistry.Service.use((registry) => registry.invalidate()))",
    )
  })

  test("virtual module types expose typed Effect services, not retired facades", () => {
    // env.d.ts is the typecheck guard for the virtual:opencode-server boundary.
    // Dead facades declared as functions would let a retired call typecheck
    // clean; bare `unknown` returns would let a wrong result shape through. Keep
    // the credential/invalidation methods on typed ServerEffect results so the
    // Settings API-key path fails at compile time, not at runtime.
    for (const namespace of ["WebSearchAuth", "LSP", "ToolRegistry"]) {
      expect(envTypes).toContain(`namespace ${namespace}`)
    }
    expect(envTypes).not.toContain("export function status(")
    expect(envTypes).not.toContain("export function shutdownAll(")
    expect(envTypes).not.toContain("export function invalidate(")
    expect(envTypes).toContain("status: () => ServerEffect<Status>")
    expect(envTypes).toContain("saveKey: (key: string) => ServerEffect<Status>")
    expect(envTypes).toContain("runPromise<Result>(effect: ServerEffect<Result>")
  })

  test("web search toggle rejects when live tool invalidation fails", () => {
    expect(mainIpc).toContain("const previous = await readWebSearchEnabled()")
    expect(mainIpc).toContain("await setWebSearchEnabled(previous)")
    expect(mainIpc).toContain("const rollbackDirectories = Instance.directories()")
    expect(mainIpc).toContain("const rollbackResults = await invalidateWebSearchTools(rollbackDirectories)")
    expect(mainIpc).toContain("websearch-set-enabled rollback failed for instance")
    expect(mainIpc).toContain("Failed to refresh Web Search tools")
  })
})
