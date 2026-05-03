import { describe, expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Session as SessionNs } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { TurnChange } from "../../src/session/turn-change"
import { MessageID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Database } from "../../src/storage/db"
import { tmpdir } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"

const messageID = MessageID.make("msg_turn_change")

async function createTurn() {
  const session = await SessionNs.create({ title: "turn change" })
  await SessionNs.updateMessage({
    id: messageID,
    sessionID: session.id,
    role: "assistant",
    parentID: MessageID.make("msg_user"),
    time: { created: Date.now() },
    modelID: ModelID.make("test"),
    providerID: ProviderID.make("test"),
    mode: "",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as MessageV2.Info)
  return { sessionID: session.id, messageID }
}

describe("TurnChange", () => {
  test("finalizes the net change from first before state to latest after state", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const turn = await createTurn()
        const target = path.join(fixture.path, "file.txt")
        await fs.writeFile(target, "one\n", "utf-8")

        TurnChange.recordWrite({
          ...turn,
          path: target,
          before: { exists: true, content: "one\n" },
          after: { exists: true, content: "two\n" },
        })
        TurnChange.recordWrite({
          ...turn,
          path: target,
          before: { exists: true, content: "two\n" },
          after: { exists: true, content: "three\n" },
        })

        const display = TurnChange.finalize(turn)

        expect(display?.files).toHaveLength(1)
        expect(display?.files[0]).toMatchObject({
          path: "file.txt",
          status: "modified",
          additions: 1,
          deletions: 1,
          expandable: true,
        })
        expect(display?.files[0].patch).toContain("-one")
        expect(display?.files[0].patch).toContain("+three")
        expect(display?.files[0].patch).not.toContain("+two")
      },
    })
  })

  test("finalizes sensitive files as status-only while keeping undo available", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const turn = await createTurn()
        const target = path.join(fixture.path, ".env")

        TurnChange.recordWrite({
          ...turn,
          path: target,
          before: { exists: false },
          after: { exists: true, content: "TOKEN=new-secret\n" },
        })

        const display = TurnChange.finalize(turn)
        const serialized = JSON.stringify(display)

        expect(display?.undoAvailable).toBe(true)
        expect(display?.files).toEqual([
          {
            path: ".env",
            status: "added",
            sensitive: true,
            expandable: false,
          },
        ])
        expect(serialized).not.toContain("new-secret")
        expect(serialized).not.toContain("@@")
      },
    })
  })

  test("finalizes large files as status-only and blocks restore when target content is unavailable", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const turn = await createTurn()
        const target = path.join(fixture.path, "large.txt")
        const large = "x".repeat(2 * 1024 * 1024 + 1)
        await fs.rm(target, { force: true })

        TurnChange.recordWrite({
          ...turn,
          path: target,
          before: { exists: true, content: large },
          after: { exists: false },
        })

        const display = TurnChange.finalize(turn)
        expect(display?.files).toEqual([
          {
            path: "large.txt",
            status: "deleted",
            large: true,
            restoreAvailable: false,
            expandable: false,
          },
        ])

        const result = await TurnChange.undo(turn)
        expect(result).toMatchObject({
          status: "blocked",
          reason: "unsupported_size",
          files: [{ path: "large.txt", reason: "restore_unavailable" }],
        })
        await expect(fs.readFile(target, "utf-8")).rejects.toThrow()
      },
    })
  })

  test("undo restores BOM bytes", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const turn = await createTurn()
        const target = path.join(fixture.path, "bom.txt")
        await fs.writeFile(target, "after\n", "utf-8")
        TurnChange.recordWrite({
          ...turn,
          path: target,
          before: { exists: true, content: "before\n", bom: true },
          after: { exists: true, content: "after\n", bom: false },
        })
        TurnChange.finalize(turn)

        expect((await TurnChange.undo(turn)).status).toBe("applied")
        const bytes = await fs.readFile(target)
        expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
        expect(bytes.toString("utf-8")).toBe("\uFEFFbefore\n")

        expect((await TurnChange.redo(turn)).status).toBe("applied")
        const redoBytes = await fs.readFile(target)
        expect([...redoBytes.slice(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf])
        expect(redoBytes.toString("utf-8")).toBe("after\n")
      },
    })
  })

  test("undo preflight conflict writes no files", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const turn = await createTurn()
        const target = path.join(fixture.path, "file.txt")
        await fs.writeFile(target, "after\n", "utf-8")
        TurnChange.recordWrite({
          ...turn,
          path: target,
          before: { exists: true, content: "before\n" },
          after: { exists: true, content: "after\n" },
        })
        TurnChange.finalize(turn)
        await fs.writeFile(target, "user edit\n", "utf-8")

        const result = await TurnChange.undo(turn)

        expect(result.status).toBe("blocked")
        expect(await fs.readFile(target, "utf-8")).toBe("user edit\n")
      },
    })
  })

  test("undo preflight blocks oversized current files without reading content", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const turn = await createTurn()
        const target = path.join(fixture.path, "file.txt")
        await fs.writeFile(target, "after\n", "utf-8")
        TurnChange.recordWrite({
          ...turn,
          path: target,
          before: { exists: true, content: "before\n" },
          after: { exists: true, content: "after\n" },
        })
        TurnChange.finalize(turn)
        await fs.writeFile(target, "x".repeat(2 * 1024 * 1024 + 1), "utf-8")

        const readFile = spyOn(fs, "readFile")
        try {
          const result = await TurnChange.undo(turn)

          expect(result).toMatchObject({
            status: "blocked",
            reason: "conflict",
            files: [{ path: "file.txt", reason: "unavailable" }],
          })
          expect(readFile.mock.calls.some((call) => call[0] === target)).toBe(false)
        } finally {
          readFile.mockRestore()
        }
      },
    })
  })

  test("finalize failure is isolated from caller cleanup", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const turn = await createTurn()
        const target = path.join(fixture.path, "file.txt")
        TurnChange.recordWrite({
          ...turn,
          path: target,
          before: { exists: false },
          after: { exists: true, content: "after\n" },
        })
        const transaction = spyOn(Database, "transaction").mockImplementation(() => {
          throw new Error("db unavailable")
        })
        try {
          expect(() => TurnChange.finalize(turn)).not.toThrow()
          expect(TurnChange.get(turn)).toBeUndefined()
        } finally {
          transaction.mockRestore()
        }
      },
    })
  })

  test("later finalized turn invalidates previous redo", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const first = await createTurn()
        const target = path.join(fixture.path, "file.txt")
        await fs.writeFile(target, "after\n", "utf-8")
        TurnChange.recordWrite({
          ...first,
          path: target,
          before: { exists: true, content: "before\n" },
          after: { exists: true, content: "after\n" },
        })
        TurnChange.finalize(first)
        expect((await TurnChange.undo(first)).status).toBe("applied")
        expect(TurnChange.get(first)?.redoAvailable).toBe(true)

        const second = { sessionID: first.sessionID, messageID: MessageID.make("msg_turn_change_2") }
        await SessionNs.updateMessage({
          id: second.messageID,
          sessionID: second.sessionID,
          role: "assistant",
          parentID: MessageID.make("msg_user_2"),
          time: { created: Date.now() },
          modelID: ModelID.make("test"),
          providerID: ProviderID.make("test"),
          mode: "",
          agent: "build",
          path: { cwd: "/", root: "/" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        } as unknown as MessageV2.Info)
        TurnChange.recordWrite({
          ...second,
          path: target,
          before: { exists: true, content: "before\n" },
          after: { exists: true, content: "new turn\n" },
        })
        TurnChange.finalize(second)

        expect(TurnChange.get(first)?.redoAvailable).toBe(false)
      },
    })
  })
})
