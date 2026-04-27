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

  test("web search toggle rejects when live tool invalidation fails", () => {
    expect(mainIpc).toContain("const previous = await Settings.webSearchEnabled()")
    expect(mainIpc).toContain("await Settings.setWebSearchEnabled(previous)")
    expect(mainIpc).toContain("const rollbackDirectories = Instance.directories()")
    expect(mainIpc).toContain("const rollbackResults = await invalidateWebSearchTools(rollbackDirectories)")
    expect(mainIpc).toContain("websearch-set-enabled rollback failed for instance")
    expect(mainIpc).toContain("Failed to refresh Web Search tools")
  })
})
