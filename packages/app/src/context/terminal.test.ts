import { beforeAll, describe, expect, mock, test } from "bun:test"

let getWorkspaceTerminalCacheKey: (dir: string) => string
let getLegacyTerminalStorageKeys: (dir: string, legacySessionID?: string) => string[]
let createTerminalBinding: typeof import("./terminal")["createTerminalBinding"]

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => ({}),
  }))
  mock.module("@opencode-ai/ui/context", () => ({
    createSimpleContext: () => ({
      use: () => undefined,
      provider: () => undefined,
    }),
  }))
  const mod = await import("./terminal")
  getWorkspaceTerminalCacheKey = mod.getWorkspaceTerminalCacheKey
  getLegacyTerminalStorageKeys = mod.getLegacyTerminalStorageKeys
  createTerminalBinding = mod.createTerminalBinding
})

describe("getWorkspaceTerminalCacheKey", () => {
  test("uses workspace-only directory cache key", () => {
    expect(getWorkspaceTerminalCacheKey("/repo")).toBe("/repo:__workspace__")
  })
})

describe("getLegacyTerminalStorageKeys", () => {
  test("keeps workspace storage path when no legacy session id", () => {
    expect(getLegacyTerminalStorageKeys("/repo")).toEqual(["/repo/terminal.v1"])
  })

  test("includes legacy session path before workspace path", () => {
    expect(getLegacyTerminalStorageKeys("/repo", "session-123")).toEqual([
      "/repo/terminal/session-123.v1",
      "/repo/terminal.v1",
    ])
  })
})

describe("createTerminalBinding", () => {
  test("returns a safe empty terminal session when the workspace accessor is undefined", async () => {
    const binding = createTerminalBinding(() => undefined)

    expect(binding.ready()).toBe(false)
    expect(binding.all()).toEqual([])
    expect(binding.active()).toBeUndefined()
    expect(binding.connection("tab_1" as never)).toBeUndefined()
    expect(() => binding.new()).not.toThrow()
    expect(() => binding.update({ tabID: "tab_1" as never, title: "Terminal 1" })).not.toThrow()
    expect(() => binding.snapshot("tab_1" as never, {})).not.toThrow()
    expect(() => binding.resize("tab_1" as never, { rows: 24, cols: 80 })).not.toThrow()
    expect(() => binding.markGone("tab_1" as never)).not.toThrow()
    expect(() => binding.open("tab_1" as never)).not.toThrow()
    expect(() => binding.move("tab_1" as never, 0)).not.toThrow()
    expect(() => binding.next()).not.toThrow()
    expect(() => binding.previous()).not.toThrow()
    await expect(binding.ensureLive("tab_1" as never)).resolves.toBeUndefined()
    await expect(binding.close("tab_1" as never)).resolves.toBeUndefined()
  })
})
