import { describe, expect, test } from "bun:test"
import { createCommandPaletteSessionEntries } from "./command-palette-search-items"

type SessionEntriesProps = Parameters<typeof createCommandPaletteSessionEntries>[0]
type ListedSession = { id: string; title: string; time: { updated: number } }

function createLanguage() {
  return {
    t: (key: string) => (key === "command.category.session" ? "Sessions" : key),
  } as SessionEntriesProps["language"]
}

function createGlobalSDK(sessionList: (input: { directory: string; roots: true }) => Promise<{ data: ListedSession[] }>) {
  return {
    client: {
      session: {
        list: sessionList,
      },
    },
  } as SessionEntriesProps["globalSDK"]
}

describe("createCommandPaletteSessionEntries", () => {
  test("reuses the session list cache across query changes and empty query resets", async () => {
    let calls = 0
    let pinnedIDs: string[] = []
    const source = createCommandPaletteSessionEntries({
      workspaces: () => ["/repo"],
      label: (directory) => directory,
      language: createLanguage(),
      pinnedIDs: () => pinnedIDs,
      globalSDK: createGlobalSDK(async () => {
        calls += 1
        return {
          data: [
            { id: "older", title: "Older", time: { updated: 1 } },
            { id: "newer", title: "Newer", time: { updated: 2 } },
          ],
        }
      }) as any,
    })

    const first = await Promise.resolve(source.sessions("older"))
    expect(calls).toBe(1)
    expect(first.map((entry) => entry.sessionID)).toEqual(["older", "newer"])

    expect(source.sessions("")).toEqual([])

    const second = await Promise.resolve(source.sessions("newer"))
    expect(calls).toBe(1)
    expect(second.map((entry) => entry.sessionID)).toEqual(["older", "newer"])

    pinnedIDs = ["newer"]
    await Promise.resolve(source.sessions("newer"))
    expect(calls).toBe(2)
  })
})
