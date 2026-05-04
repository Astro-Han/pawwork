import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Session as SessionNs } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { TurnChange } from "../../src/session/turn-change"
import { MessageID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { tmpdir } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"

async function makeAssistant(sessionID: SessionID, parentID: MessageID, suffix: string) {
  const id = MessageID.make(`msg_assistant_${suffix}`)
  await SessionNs.updateMessage({
    id,
    sessionID,
    role: "assistant",
    parentID,
    time: { created: Date.now(), completed: Date.now() },
    modelID: ModelID.make("test"),
    providerID: ProviderID.make("test"),
    mode: "",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as MessageV2.Info)
  return id
}

async function makeUser(sessionID: SessionID, suffix: string) {
  const id = MessageID.make(`msg_user_${suffix}`)
  await SessionNs.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: {
      providerID: ProviderID.make("test"),
      modelID: ModelID.make("test"),
    },
  } as unknown as MessageV2.Info)
  return id
}

describe("TurnChange.MutationResultSchema", () => {
  test("accepts rollback_failed as a blocked reason", () => {
    const parsed = TurnChange.MutationResultSchema.safeParse({
      status: "blocked",
      reason: "rollback_failed",
      files: [{ path: "alpha.txt", reason: "rollback" }],
    })
    expect(parsed.success).toBe(true)
  })
})

describe("TurnChange.aggregateTurn", () => {
  test("collapses two assistants editing different files into one display", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "agg" })
        const userMessageID = await makeUser(session.id, "agg")
        const a1 = await makeAssistant(session.id, userMessageID, "a1")
        const a2 = await makeAssistant(session.id, userMessageID, "a2")

        TurnChange.recordWrite({
          sessionID: session.id,
          messageID: a1,
          path: path.join(fixture.path, "alpha.txt"),
          before: { exists: false },
          after: { exists: true, content: "A\n" },
        })
        TurnChange.finalize({ sessionID: session.id, messageID: a1 })

        TurnChange.recordWrite({
          sessionID: session.id,
          messageID: a2,
          path: path.join(fixture.path, "beta.txt"),
          before: { exists: false },
          after: { exists: true, content: "B\n" },
        })
        TurnChange.finalize({ sessionID: session.id, messageID: a2 })

        const display = TurnChange.aggregateTurn({ sessionID: session.id, userMessageID })
        expect(display?.files.map((f) => f.path)).toEqual(["alpha.txt", "beta.txt"])
        expect(display?.undoAvailable).toBe(true)
        expect(display?.turnID).toBe(userMessageID)
        expect(display?.messageID).toBe(userMessageID)
      },
    })
  })

  test("collapses same file edited by two assistants into single net diff", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "agg-same" })
        const userMessageID = await makeUser(session.id, "same")
        const a1 = await makeAssistant(session.id, userMessageID, "s1")
        const a2 = await makeAssistant(session.id, userMessageID, "s2")
        const target = path.join(fixture.path, "f.txt")
        await fs.writeFile(target, "one\n", "utf-8")

        TurnChange.recordWrite({
          sessionID: session.id,
          messageID: a1,
          path: target,
          before: { exists: true, content: "one\n" },
          after: { exists: true, content: "two\n" },
        })
        TurnChange.finalize({ sessionID: session.id, messageID: a1 })

        TurnChange.recordWrite({
          sessionID: session.id,
          messageID: a2,
          path: target,
          before: { exists: true, content: "two\n" },
          after: { exists: true, content: "three\n" },
        })
        TurnChange.finalize({ sessionID: session.id, messageID: a2 })

        const display = TurnChange.aggregateTurn({ sessionID: session.id, userMessageID })
        expect(display?.files).toHaveLength(1)
        expect(display?.files[0].patch).toContain("-one")
        expect(display?.files[0].patch).toContain("+three")
        expect(display?.files[0].patch).not.toContain("+two")
      },
    })
  })

  test("white-busy file (created then deleted) is filtered out", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "wb" })
        const userMessageID = await makeUser(session.id, "wb")
        const a1 = await makeAssistant(session.id, userMessageID, "wb1")
        const a2 = await makeAssistant(session.id, userMessageID, "wb2")
        const target = path.join(fixture.path, "ghost.txt")

        TurnChange.recordWrite({
          sessionID: session.id,
          messageID: a1,
          path: target,
          before: { exists: false },
          after: { exists: true, content: "g\n" },
        })
        TurnChange.finalize({ sessionID: session.id, messageID: a1 })

        TurnChange.recordWrite({
          sessionID: session.id,
          messageID: a2,
          path: target,
          before: { exists: true, content: "g\n" },
          after: { exists: false },
        })
        TurnChange.finalize({ sessionID: session.id, messageID: a2 })

        const display = TurnChange.aggregateTurn({ sessionID: session.id, userMessageID })
        expect(display?.files ?? []).toEqual([])
      },
    })
  })

  test("returns undefined when no assistant changes", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "empty" })
        const userMessageID = await makeUser(session.id, "empty")
        const display = TurnChange.aggregateTurn({ sessionID: session.id, userMessageID })
        expect(display).toBeUndefined()
      },
    })
  })

  test("ignores assistant messages with a different parent", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "scope" })
        const userA = await makeUser(session.id, "scopeA")
        const userB = await makeUser(session.id, "scopeB")
        const a1 = await makeAssistant(session.id, userA, "p1")
        const a2 = await makeAssistant(session.id, userB, "p2")
        TurnChange.recordWrite({
          sessionID: session.id,
          messageID: a1,
          path: path.join(fixture.path, "in.txt"),
          before: { exists: false },
          after: { exists: true, content: "in\n" },
        })
        TurnChange.finalize({ sessionID: session.id, messageID: a1 })
        TurnChange.recordWrite({
          sessionID: session.id,
          messageID: a2,
          path: path.join(fixture.path, "out.txt"),
          before: { exists: false },
          after: { exists: true, content: "out\n" },
        })
        TurnChange.finalize({ sessionID: session.id, messageID: a2 })

        const display = TurnChange.aggregateTurn({ sessionID: session.id, userMessageID: userA })
        expect(display?.files.map((f) => f.path)).toEqual(["in.txt"])
      },
    })
  })
})

describe("TurnChange.aggregateTurnUndo / aggregateTurnRedo", () => {
  test("undoes all assistant changes in a turn and restores files", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "undo" })
        const userMessageID = await makeUser(session.id, "u1")
        const a1 = await makeAssistant(session.id, userMessageID, "u-a1")
        const a2 = await makeAssistant(session.id, userMessageID, "u-a2")
        const fileA = path.join(fixture.path, "u-a.txt")
        const fileB = path.join(fixture.path, "u-b.txt")
        await fs.writeFile(fileA, "newA\n", "utf-8")
        await fs.writeFile(fileB, "newB\n", "utf-8")

        TurnChange.recordWrite({
          sessionID: session.id,
          messageID: a1,
          path: fileA,
          before: { exists: false },
          after: { exists: true, content: "newA\n" },
        })
        TurnChange.finalize({ sessionID: session.id, messageID: a1 })
        TurnChange.recordWrite({
          sessionID: session.id,
          messageID: a2,
          path: fileB,
          before: { exists: false },
          after: { exists: true, content: "newB\n" },
        })
        TurnChange.finalize({ sessionID: session.id, messageID: a2 })

        const result = await TurnChange.aggregateTurnUndo({ sessionID: session.id, userMessageID })
        expect(result.status).toBe("applied")
        if (result.status !== "applied") return
        expect(result.display.undoAvailable).toBe(false)
        expect(result.display.redoAvailable).toBe(true)
        expect(await fs.access(fileA).then(() => true).catch(() => false)).toBe(false)
        expect(await fs.access(fileB).then(() => true).catch(() => false)).toBe(false)
        expect(result.skipped ?? []).toEqual([])
      },
    })
  })

  test("redoes after undo and re-applies all files", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "redo" })
        const userMessageID = await makeUser(session.id, "r1")
        const a1 = await makeAssistant(session.id, userMessageID, "r-a1")
        const fileA = path.join(fixture.path, "r-a.txt")
        await fs.writeFile(fileA, "newA\n", "utf-8")

        TurnChange.recordWrite({
          sessionID: session.id,
          messageID: a1,
          path: fileA,
          before: { exists: false },
          after: { exists: true, content: "newA\n" },
        })
        TurnChange.finalize({ sessionID: session.id, messageID: a1 })

        const undoResult = await TurnChange.aggregateTurnUndo({ sessionID: session.id, userMessageID })
        expect(undoResult.status).toBe("applied")
        const redoResult = await TurnChange.aggregateTurnRedo({ sessionID: session.id, userMessageID })
        expect(redoResult.status).toBe("applied")
        if (redoResult.status !== "applied") return
        expect(redoResult.display.undoAvailable).toBe(true)
        expect(redoResult.display.redoAvailable).toBe(false)
        expect(await fs.readFile(fileA, "utf-8")).toBe("newA\n")
      },
    })
  })

  test("blocks the whole turn on conflict by default", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "blk" })
        const userMessageID = await makeUser(session.id, "b1")
        const a1 = await makeAssistant(session.id, userMessageID, "b-a1")
        const a2 = await makeAssistant(session.id, userMessageID, "b-a2")
        const ok = path.join(fixture.path, "b-ok.txt")
        const conflict = path.join(fixture.path, "b-cnf.txt")
        await fs.writeFile(ok, "newOK\n", "utf-8")
        await fs.writeFile(conflict, "tampered\n", "utf-8")

        TurnChange.recordWrite({
          sessionID: session.id,
          messageID: a1,
          path: ok,
          before: { exists: false },
          after: { exists: true, content: "newOK\n" },
        })
        TurnChange.finalize({ sessionID: session.id, messageID: a1 })
        TurnChange.recordWrite({
          sessionID: session.id,
          messageID: a2,
          path: conflict,
          before: { exists: false },
          after: { exists: true, content: "expectedConflict\n" },
        })
        TurnChange.finalize({ sessionID: session.id, messageID: a2 })

        const result = await TurnChange.aggregateTurnUndo({ sessionID: session.id, userMessageID })
        expect(result.status).toBe("blocked")
        if (result.status !== "blocked") return
        expect(result.reason).toBe("conflict")
        // safe file untouched
        expect(await fs.readFile(ok, "utf-8")).toBe("newOK\n")
      },
    })
  })

  test("chained same-file edits across two assistants undo cleanly without conflict", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "chain" })
        const userMessageID = await makeUser(session.id, "chain")
        const a1 = await makeAssistant(session.id, userMessageID, "chain-a1")
        const a2 = await makeAssistant(session.id, userMessageID, "chain-a2")
        const target = path.join(fixture.path, "chain.txt")

        await fs.writeFile(target, "two\n", "utf-8")
        TurnChange.recordWrite({
          sessionID: session.id,
          messageID: a1,
          path: target,
          before: { exists: false },
          after: { exists: true, content: "two\n" },
        })
        TurnChange.finalize({ sessionID: session.id, messageID: a1 })

        await fs.writeFile(target, "three\n", "utf-8")
        TurnChange.recordWrite({
          sessionID: session.id,
          messageID: a2,
          path: target,
          before: { exists: true, content: "two\n" },
          after: { exists: true, content: "three\n" },
        })
        TurnChange.finalize({ sessionID: session.id, messageID: a2 })

        const result = await TurnChange.aggregateTurnUndo({ sessionID: session.id, userMessageID })
        expect(result.status).toBe("applied")
        if (result.status !== "applied") return
        expect(result.skipped ?? []).toEqual([])
        expect(await fs.access(target).then(() => true).catch(() => false)).toBe(false)

        const redo = await TurnChange.aggregateTurnRedo({ sessionID: session.id, userMessageID })
        expect(redo.status).toBe("applied")
        if (redo.status !== "applied") return
        expect(await fs.readFile(target, "utf-8")).toBe("three\n")
      },
    })
  })

  test("two assistants editing different absolute paths sharing a basename do not merge", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "collide" })
        const userMessageID = await makeUser(session.id, "collide")
        const a1 = await makeAssistant(session.id, userMessageID, "c-a1")
        const a2 = await makeAssistant(session.id, userMessageID, "c-a2")
        const dirA = path.join(fixture.path, "alpha")
        const dirB = path.join(fixture.path, "beta")
        await fs.mkdir(dirA, { recursive: true })
        await fs.mkdir(dirB, { recursive: true })
        const fileA = path.join(dirA, "shared.txt")
        const fileB = path.join(dirB, "shared.txt")

        TurnChange.recordWrite({
          sessionID: session.id,
          messageID: a1,
          path: fileA,
          before: { exists: false },
          after: { exists: true, content: "A\n" },
        })
        TurnChange.finalize({ sessionID: session.id, messageID: a1 })
        TurnChange.recordWrite({
          sessionID: session.id,
          messageID: a2,
          path: fileB,
          before: { exists: false },
          after: { exists: true, content: "B\n" },
        })
        TurnChange.finalize({ sessionID: session.id, messageID: a2 })

        const display = TurnChange.aggregateTurn({ sessionID: session.id, userMessageID })
        expect(display?.files).toHaveLength(2)
        const openPaths = (display?.files ?? []).map((f) => f.openPath).sort()
        expect(openPaths).toEqual([fileA, fileB].sort())
      },
    })
  })

  test("mixed-state turn (one applied, one undone) keeps both undo and redo available", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "mixed" })
        const userMessageID = await makeUser(session.id, "mix")
        const a1 = await makeAssistant(session.id, userMessageID, "m-a1")
        const a2 = await makeAssistant(session.id, userMessageID, "m-a2")
        const fileA = path.join(fixture.path, "m-a.txt")
        const fileB = path.join(fixture.path, "m-b.txt")
        await fs.writeFile(fileA, "A\n", "utf-8")
        await fs.writeFile(fileB, "B\n", "utf-8")

        TurnChange.recordWrite({
          sessionID: session.id,
          messageID: a1,
          path: fileA,
          before: { exists: false },
          after: { exists: true, content: "A\n" },
        })
        TurnChange.finalize({ sessionID: session.id, messageID: a1 })
        TurnChange.recordWrite({
          sessionID: session.id,
          messageID: a2,
          path: fileB,
          before: { exists: false },
          after: { exists: true, content: "B\n" },
        })
        TurnChange.finalize({ sessionID: session.id, messageID: a2 })

        const undoSecond = await TurnChange.undo({ sessionID: session.id, messageID: a2 })
        expect(undoSecond.status).toBe("applied")

        const display = TurnChange.aggregateTurn({ sessionID: session.id, userMessageID })
        expect(display?.undoAvailable).toBe(true)
        expect(display?.redoAvailable).toBe(true)
      },
    })
  })

  test("aggregateTurnUndo reports mutatedPaths only for messages actually written", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "mutated" })
        const userMessageID = await makeUser(session.id, "mp")
        const a1 = await makeAssistant(session.id, userMessageID, "mp-a1")
        const a2 = await makeAssistant(session.id, userMessageID, "mp-a2")
        const ok = path.join(fixture.path, "mp-ok.txt")
        const conflict = path.join(fixture.path, "mp-cnf.txt")
        await fs.writeFile(ok, "OK\n", "utf-8")
        await fs.writeFile(conflict, "tampered\n", "utf-8")

        TurnChange.recordWrite({
          sessionID: session.id,
          messageID: a1,
          path: ok,
          before: { exists: false },
          after: { exists: true, content: "OK\n" },
        })
        TurnChange.finalize({ sessionID: session.id, messageID: a1 })
        TurnChange.recordWrite({
          sessionID: session.id,
          messageID: a2,
          path: conflict,
          before: { exists: false },
          after: { exists: true, content: "expectedConflict\n" },
        })
        TurnChange.finalize({ sessionID: session.id, messageID: a2 })

        const result = await TurnChange.aggregateTurnUndo({
          sessionID: session.id,
          userMessageID,
          force: true,
        })
        expect(result.status).toBe("applied")
        if (result.status !== "applied") return
        expect(result.mutatedPaths).toEqual([ok])
      },
    })
  })

  test("force=true skips conflicting message and reports skipped[]", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "force" })
        const userMessageID = await makeUser(session.id, "f1")
        const a1 = await makeAssistant(session.id, userMessageID, "f-a1")
        const a2 = await makeAssistant(session.id, userMessageID, "f-a2")
        const ok = path.join(fixture.path, "f-ok.txt")
        const conflict = path.join(fixture.path, "f-cnf.txt")
        await fs.writeFile(ok, "newOK\n", "utf-8")
        await fs.writeFile(conflict, "tampered\n", "utf-8")

        TurnChange.recordWrite({
          sessionID: session.id,
          messageID: a1,
          path: ok,
          before: { exists: false },
          after: { exists: true, content: "newOK\n" },
        })
        TurnChange.finalize({ sessionID: session.id, messageID: a1 })
        TurnChange.recordWrite({
          sessionID: session.id,
          messageID: a2,
          path: conflict,
          before: { exists: false },
          after: { exists: true, content: "expectedConflict\n" },
        })
        TurnChange.finalize({ sessionID: session.id, messageID: a2 })

        const result = await TurnChange.aggregateTurnUndo({
          sessionID: session.id,
          userMessageID,
          force: true,
        })
        expect(result.status).toBe("applied")
        if (result.status !== "applied") return
        expect(result.skipped?.length ?? 0).toBeGreaterThan(0)
        // a1's file undone (deleted)
        expect(await fs.access(ok).then(() => true).catch(() => false)).toBe(false)
        // conflict file left as-is
        expect(await fs.readFile(conflict, "utf-8")).toBe("tampered\n")
      },
    })
  })
})
