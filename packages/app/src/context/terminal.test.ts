import { beforeAll, describe, expect, mock, test } from "bun:test"

let getWorkspaceTerminalCacheKey: (dir: string) => string
let getLegacyTerminalStorageKeys: (dir: string, legacySessionID?: string) => string[]
let migrateTerminalState: (value: unknown) => unknown
let replaceTerminalWithClone: typeof import("./terminal")["replaceTerminalWithClone"]
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
  migrateTerminalState = mod.migrateTerminalState
  replaceTerminalWithClone = mod.replaceTerminalWithClone
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

describe("migrateTerminalState", () => {
  test("drops invalid terminals and restores a valid active terminal", () => {
    expect(
      migrateTerminalState({
        active: "missing",
        all: [
          null,
          { id: "one", title: "Terminal 2" },
          { id: "one", title: "duplicate", titleNumber: 9 },
          { id: "two", title: "logs", titleNumber: 4, rows: 24, cols: 80 },
          { title: "no-id" },
        ],
      }),
    ).toEqual({
      active: "one",
      all: [
        { id: "one", title: "Terminal 2", titleNumber: 2 },
        { id: "two", title: "logs", titleNumber: 4, rows: 24, cols: 80 },
      ],
    })
  })

  test("keeps a valid active id", () => {
    expect(
      migrateTerminalState({
        active: "two",
        all: [
          { id: "one", title: "Terminal 1" },
          { id: "two", title: "shell", titleNumber: 7 },
        ],
      }),
    ).toEqual({
      active: "two",
      all: [
        { id: "one", title: "Terminal 1", titleNumber: 1 },
        { id: "two", title: "shell", titleNumber: 7 },
      ],
    })
  })
})

describe("replaceTerminalWithClone", () => {
  test("replaces a stale runtime pty id and keeps the durable tab metadata", () => {
    expect(
      replaceTerminalWithClone(
        {
          active: "pty_old",
          all: [
            {
              id: "pty_old",
              title: "Terminal 2",
              titleNumber: 2,
              buffer: "old output",
              cursor: 12,
              scrollY: 8,
              rows: 24,
              cols: 80,
            },
          ],
        },
        "pty_old",
        { id: "pty_new", title: "Terminal 2" },
      ),
    ).toEqual({
      active: "pty_new",
      all: [{ id: "pty_new", title: "Terminal 2", titleNumber: 2 }],
    })
  })

  test("returns the original state when the stale id no longer exists", () => {
    const current = {
      active: "pty_a",
      all: [{ id: "pty_a", title: "Terminal 1", titleNumber: 1 }],
    }

    expect(replaceTerminalWithClone(current, "pty_missing", { id: "pty_new", title: "Terminal 1" })).toBe(current)
  })
})

describe("createTerminalBinding", () => {
  test("returns a safe empty terminal session when the workspace accessor is undefined", async () => {
    const binding = createTerminalBinding(() => undefined)

    expect(binding.ready()).toBe(false)
    expect(binding.all()).toEqual([])
    expect(binding.active()).toBeUndefined()
    expect(() => binding.new()).not.toThrow()
    expect(() => binding.trim("pty-1")).not.toThrow()
    expect(() => binding.trimAll()).not.toThrow()
    expect(() => binding.open("pty-1")).not.toThrow()
    expect(() => binding.move("pty-1", 0)).not.toThrow()
    expect(() => binding.next()).not.toThrow()
    expect(() => binding.previous()).not.toThrow()
    await expect(binding.clone("pty-1")).resolves.toBeUndefined()
    await expect(binding.close("pty-1")).resolves.toBeUndefined()
  })
})
