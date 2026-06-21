import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const mainIpc = readFileSync(resolve(import.meta.dir, "ipc.ts"), "utf8")
const preload = readFileSync(resolve(import.meta.dir, "../preload/index.ts"), "utf8")
const preloadTypes = readFileSync(resolve(import.meta.dir, "../preload/types.ts"), "utf8")
const envTypes = readFileSync(resolve(import.meta.dir, "env.d.ts"), "utf8")
const nodeEntry = readFileSync(resolve(import.meta.dir, "../../../opencode/src/node.ts"), "utf8")

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

  test("credential and tool-invalidation handlers use Effect services instead of retired facades", () => {
    // These namespaces became Effect services in the settings migration; the
    // top-level Promise facades no longer exist and throw "is not a function"
    // at runtime (the 2026.6.10 Settings crash). Keep every handler on
    // AppRuntime.runPromise(<Service>.use(...)).
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
    for (const effectCall of [
      "AppRuntime.runPromise(WebSearchAuth.Service.use",
      "AppRuntime.runPromise(LSP.Service.use",
      "AppRuntime.runPromise(ToolRegistry.Service.use",
    ]) {
      expect(mainIpc).toContain(effectCall)
    }
  })

  test("virtual module types expose Effect services, not retired facades", () => {
    // env.d.ts is the only typecheck guard for the virtual:opencode-server
    // boundary. If it keeps declaring the dead facades as functions, a handler
    // that calls them typechecks clean and only fails at runtime.
    for (const namespace of ["WebSearchAuth", "LSP", "ToolRegistry"]) {
      expect(envTypes).toContain(`namespace ${namespace}`)
    }
    expect(envTypes).not.toContain("export function status(")
    expect(envTypes).not.toContain("export function shutdownAll(")
    expect(envTypes).not.toContain("export function invalidate(")
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
