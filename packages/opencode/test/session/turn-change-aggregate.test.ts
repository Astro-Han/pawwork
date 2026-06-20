import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Session as SessionNs } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { TurnChange } from "../../src/session/turn-change"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { SessionTable } from "../../src/session/session.sql"
import { Database, eq } from "../../src/storage/db"
import { Bus } from "../../src/bus"
import { AppRuntime } from "../../src/effect/app-runtime"
import { tmpdir } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"

const turnChange = await AppRuntime.runPromise(TurnChange.Service)
const recordWrite = (input: Parameters<typeof turnChange.recordWrite>[0]) =>
  AppRuntime.runSync(turnChange.recordWrite(input))
const recordUncaptured = (input: Parameters<typeof turnChange.recordUncaptured>[0]) =>
  AppRuntime.runSync(turnChange.recordUncaptured(input))
const finalize = (input: Parameters<typeof turnChange.finalize>[0]) => AppRuntime.runSync(turnChange.finalize(input))
const aggregateTurn = (input: Parameters<typeof turnChange.aggregateTurn>[0]) =>
  AppRuntime.runSync(turnChange.aggregateTurn(input))
const aggregateTurnUnion = (input: Parameters<typeof turnChange.aggregateTurnUnion>[0]) =>
  AppRuntime.runSync(turnChange.aggregateTurnUnion(input))
const aggregateSessionFromTurns = (input: Parameters<typeof turnChange.aggregateSessionFromTurns>[0]) =>
  AppRuntime.runSync(turnChange.aggregateSessionFromTurns(input))
const undo = (input: Parameters<typeof turnChange.undo>[0]) => AppRuntime.runPromise(turnChange.undo(input))
const aggregateTurnUndo = (input: Parameters<typeof turnChange.aggregateTurnUndo>[0]) =>
  AppRuntime.runPromise(turnChange.aggregateTurnUndo(input))
const aggregateTurnRedo = (input: Parameters<typeof turnChange.aggregateTurnRedo>[0]) =>
  AppRuntime.runPromise(turnChange.aggregateTurnRedo(input))

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

        recordWrite({
          sessionID: session.id,
          messageID: a1,
          path: path.join(fixture.path, "alpha.txt"),
          before: { exists: false },
          after: { exists: true, content: "A\n" },
        })
        finalize({ sessionID: session.id, messageID: a1 })

        recordWrite({
          sessionID: session.id,
          messageID: a2,
          path: path.join(fixture.path, "beta.txt"),
          before: { exists: false },
          after: { exists: true, content: "B\n" },
        })
        finalize({ sessionID: session.id, messageID: a2 })

        const display = aggregateTurn({ sessionID: session.id, userMessageID })
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

        recordWrite({
          sessionID: session.id,
          messageID: a1,
          path: target,
          before: { exists: true, content: "one\n" },
          after: { exists: true, content: "two\n" },
        })
        finalize({ sessionID: session.id, messageID: a1 })

        recordWrite({
          sessionID: session.id,
          messageID: a2,
          path: target,
          before: { exists: true, content: "two\n" },
          after: { exists: true, content: "three\n" },
        })
        finalize({ sessionID: session.id, messageID: a2 })

        const display = aggregateTurn({ sessionID: session.id, userMessageID })
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

        recordWrite({
          sessionID: session.id,
          messageID: a1,
          path: target,
          before: { exists: false },
          after: { exists: true, content: "g\n" },
        })
        finalize({ sessionID: session.id, messageID: a1 })

        recordWrite({
          sessionID: session.id,
          messageID: a2,
          path: target,
          before: { exists: true, content: "g\n" },
          after: { exists: false },
        })
        finalize({ sessionID: session.id, messageID: a2 })

        const display = aggregateTurn({ sessionID: session.id, userMessageID })
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
        const display = aggregateTurn({ sessionID: session.id, userMessageID })
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
        recordWrite({
          sessionID: session.id,
          messageID: a1,
          path: path.join(fixture.path, "in.txt"),
          before: { exists: false },
          after: { exists: true, content: "in\n" },
        })
        finalize({ sessionID: session.id, messageID: a1 })
        recordWrite({
          sessionID: session.id,
          messageID: a2,
          path: path.join(fixture.path, "out.txt"),
          before: { exists: false },
          after: { exists: true, content: "out\n" },
        })
        finalize({ sessionID: session.id, messageID: a2 })

        const display = aggregateTurn({ sessionID: session.id, userMessageID: userA })
        expect(display?.files.map((f) => f.path)).toEqual(["in.txt"])
      },
    })
  })
})

describe("TurnChange aggregate union", () => {
  test("aggregateTurnUnion returns empty for a user turn with no captured or uncaptured rows", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "union-empty" })
        const userMessageID = await makeUser(session.id, "union-empty")

        const result = aggregateTurnUnion({ sessionID: session.id, userMessageID })

        expect(result).toMatchObject({ kind: "empty" })
      },
    })
  })

  test("recordUncaptured publishes turn change invalidation", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "union-invalidate-uncaptured" })
        const userMessageID = await makeUser(session.id, "union-invalidate-uncaptured")
        const assistantID = await makeAssistant(session.id, userMessageID, "union-invalidate-uncaptured")
        const events: string[] = []
        const unsubscribe = Bus.subscribe(SessionNs.Event.TurnChangeInvalidated, (event) => {
          events.push(event.properties.sessionID)
        })
        try {
          recordUncaptured({ sessionID: session.id, messageID: assistantID })
          await new Promise((resolve) => setTimeout(resolve, 20))

          expect(events).toEqual([session.id])
        } finally {
          unsubscribe()
        }
      },
    })
  })

  test("finalize publishes turn change invalidation for captured display", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "union-invalidate-captured" })
        const userMessageID = await makeUser(session.id, "union-invalidate-captured")
        const assistantID = await makeAssistant(session.id, userMessageID, "union-invalidate-captured")
        const events: string[] = []
        const unsubscribe = Bus.subscribe(SessionNs.Event.TurnChangeInvalidated, (event) => {
          events.push(event.properties.sessionID)
        })
        try {
          recordWrite({
            sessionID: session.id,
            messageID: assistantID,
            path: path.join(fixture.path, "captured.txt"),
            before: { exists: false },
            after: { exists: true, content: "captured\n" },
          })
          finalize({ sessionID: session.id, messageID: assistantID })
          await new Promise((resolve) => setTimeout(resolve, 20))

          expect(events).toEqual([session.id])
        } finally {
          unsubscribe()
        }
      },
    })
  })

  test("aggregateTurnUnion returns captured with restoreState for applied rows", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "union-captured" })
        const userMessageID = await makeUser(session.id, "union-captured")
        const assistantID = await makeAssistant(session.id, userMessageID, "union-captured")

        recordWrite({
          sessionID: session.id,
          messageID: assistantID,
          path: path.join(fixture.path, "captured.txt"),
          before: { exists: false },
          after: { exists: true, content: "captured\n" },
        })
        finalize({ sessionID: session.id, messageID: assistantID })

        const result = aggregateTurnUnion({ sessionID: session.id, userMessageID })

        expect(result).toMatchObject({ kind: "captured", files: [{ path: "captured.txt", restoreState: "applied" }] })
      },
    })
  })

  test("aggregateTurnUnion returns captured with muted restoreState for fully undone rows", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "union-undone" })
        const userMessageID = await makeUser(session.id, "union-undone")
        const assistantID = await makeAssistant(session.id, userMessageID, "union-undone")
        const target = path.join(fixture.path, "undone.txt")
        await fs.writeFile(target, "after\n", "utf-8")

        recordWrite({
          sessionID: session.id,
          messageID: assistantID,
          path: target,
          before: { exists: false },
          after: { exists: true, content: "after\n" },
        })
        finalize({ sessionID: session.id, messageID: assistantID })
        await undo({ sessionID: session.id, messageID: assistantID })

        const result = aggregateTurnUnion({ sessionID: session.id, userMessageID })

        expect(result).toMatchObject({ kind: "captured", files: [{ path: "undone.txt", restoreState: "undone" }] })
      },
    })
  })

  test("aggregateTurnUnion marks files from mixed-state assistants independently", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "union-mixed-file-state" })
        const userMessageID = await makeUser(session.id, "union-mixed-file-state")
        const undoneAssistant = await makeAssistant(session.id, userMessageID, "union-mixed-file-state-undone")
        const appliedAssistant = await makeAssistant(session.id, userMessageID, "union-mixed-file-state-applied")
        const undoneFile = path.join(fixture.path, "undone-file.txt")
        const appliedFile = path.join(fixture.path, "applied-file.txt")
        await fs.writeFile(undoneFile, "after undone\n", "utf-8")

        recordWrite({
          sessionID: session.id,
          messageID: undoneAssistant,
          path: undoneFile,
          before: { exists: false },
          after: { exists: true, content: "after undone\n" },
        })
        finalize({ sessionID: session.id, messageID: undoneAssistant })
        recordWrite({
          sessionID: session.id,
          messageID: appliedAssistant,
          path: appliedFile,
          before: { exists: false },
          after: { exists: true, content: "after applied\n" },
        })
        finalize({ sessionID: session.id, messageID: appliedAssistant })
        await undo({ sessionID: session.id, messageID: undoneAssistant })

        const result = aggregateTurnUnion({ sessionID: session.id, userMessageID })

        expect(result).toMatchObject({ kind: "captured" })
        if (result.kind !== "captured") return
        expect(result.files).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: "undone-file.txt", restoreState: "undone" }),
            expect.objectContaining({ path: "applied-file.txt", restoreState: "applied" }),
          ]),
        )
      },
    })
  })

  test("aggregateTurnUnion carries omitted file metadata from truncated turns", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "union-truncated" })
        const userMessageID = await makeUser(session.id, "union-truncated")
        const assistantID = await makeAssistant(session.id, userMessageID, "union-truncated")

        for (let index = 0; index < 201; index++) {
          recordWrite({
            sessionID: session.id,
            messageID: assistantID,
            path: path.join(fixture.path, `truncated-${index}.txt`),
            before: { exists: false },
            after: { exists: true, content: `${index}\n` },
          })
        }
        finalize({ sessionID: session.id, messageID: assistantID })

        const result = aggregateTurnUnion({ sessionID: session.id, userMessageID })

        expect(result).toMatchObject({ kind: "captured", truncated: true, omittedCount: 1 })
      },
    })
  })

  test("aggregateTurnUnion keeps earlier applied same-path diff after later assistant undo", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "union-turn-same-path-later-undone" })
        const userMessageID = await makeUser(session.id, "union-turn-same-path-later-undone")
        const firstAssistant = await makeAssistant(session.id, userMessageID, "union-turn-same-path-later-undone-first")
        const secondAssistant = await makeAssistant(
          session.id,
          userMessageID,
          "union-turn-same-path-later-undone-second",
        )
        const target = path.join(fixture.path, "same-turn-undone.txt")
        await fs.writeFile(target, "A\n", "utf-8")

        await fs.writeFile(target, "B\n", "utf-8")
        recordWrite({
          sessionID: session.id,
          messageID: firstAssistant,
          path: target,
          before: { exists: true, content: "A\n" },
          after: { exists: true, content: "B\n" },
        })
        finalize({ sessionID: session.id, messageID: firstAssistant })
        await fs.writeFile(target, "C\n", "utf-8")
        recordWrite({
          sessionID: session.id,
          messageID: secondAssistant,
          path: target,
          before: { exists: true, content: "B\n" },
          after: { exists: true, content: "C\n" },
        })
        finalize({ sessionID: session.id, messageID: secondAssistant })
        await undo({ sessionID: session.id, messageID: secondAssistant })

        const result = aggregateTurnUnion({ sessionID: session.id, userMessageID })

        expect(await fs.readFile(target, "utf-8")).toBe("B\n")
        expect(result).toMatchObject({ kind: "captured" })
        if (result.kind !== "captured") return
        expect(result.files).toHaveLength(1)
        expect(result.files[0]).toMatchObject({ path: "same-turn-undone.txt", restoreState: "applied" })
        expect(result.files[0].patch).toContain("-A")
        expect(result.files[0].patch).toContain("+B")
        expect(result.files[0].patch).not.toContain("+C")
      },
    })
  })

  test("aggregateTurnUnion returns uncaptured when only uncaptured bash activity exists", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "union-uncaptured" })
        const userMessageID = await makeUser(session.id, "union-uncaptured")
        const assistantID = await makeAssistant(session.id, userMessageID, "union-uncaptured")

        recordUncaptured({ sessionID: session.id, messageID: assistantID })

        const result = aggregateTurnUnion({ sessionID: session.id, userMessageID })

        expect(result).toMatchObject({ kind: "uncaptured", count: 1 })
      },
    })
  })

  test("aggregateTurnUnion returns mixed when captured and uncaptured rows both exist", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "union-mixed" })
        const userMessageID = await makeUser(session.id, "union-mixed")
        const assistantID = await makeAssistant(session.id, userMessageID, "union-mixed")

        recordWrite({
          sessionID: session.id,
          messageID: assistantID,
          path: path.join(fixture.path, "mixed.txt"),
          before: { exists: false },
          after: { exists: true, content: "mixed\n" },
        })
        finalize({ sessionID: session.id, messageID: assistantID })
        recordUncaptured({ sessionID: session.id, messageID: assistantID })

        const result = aggregateTurnUnion({ sessionID: session.id, userMessageID })

        expect(result).toMatchObject({
          kind: "mixed",
          count: 1,
          files: [{ path: "mixed.txt", restoreState: "applied" }],
        })
      },
    })
  })

  test("aggregateSessionFromTurns ignores reverted messages at the message cutoff", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "union-session" })
        const firstUser = await makeUser(session.id, "union-session-first")
        const firstAssistant = await makeAssistant(session.id, firstUser, "union-session-first")
        const secondUser = await makeUser(session.id, "union-session-second")
        const secondAssistant = await makeAssistant(session.id, secondUser, "union-session-second")

        recordWrite({
          sessionID: session.id,
          messageID: firstAssistant,
          path: path.join(fixture.path, "kept.txt"),
          before: { exists: false },
          after: { exists: true, content: "kept\n" },
        })
        finalize({ sessionID: session.id, messageID: firstAssistant })
        recordWrite({
          sessionID: session.id,
          messageID: secondAssistant,
          path: path.join(fixture.path, "reverted.txt"),
          before: { exists: false },
          after: { exists: true, content: "reverted\n" },
        })
        finalize({ sessionID: session.id, messageID: secondAssistant })
        Database.use((db) =>
          db
            .update(SessionTable)
            .set({ revert: { messageID: secondUser } })
            .where(eq(SessionTable.id, session.id))
            .run(),
        )

        const result = aggregateSessionFromTurns({ sessionID: session.id })

        expect(result).toMatchObject({ kind: "captured", files: [{ path: "kept.txt" }] })
        expect(
          result.kind === "captured" || result.kind === "mixed" ? result.files.map((file) => file.path) : [],
        ).not.toContain("reverted.txt")
      },
    })
  })

  test("aggregateSessionFromTurns keeps the cutoff user message for part-level revert", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "union-session-part-revert" })
        const firstUser = await makeUser(session.id, "union-session-part-revert-first")
        const firstAssistant = await makeAssistant(session.id, firstUser, "union-session-part-revert-first")

        recordWrite({
          sessionID: session.id,
          messageID: firstAssistant,
          path: path.join(fixture.path, "part-kept.txt"),
          before: { exists: false },
          after: { exists: true, content: "part kept\n" },
        })
        finalize({ sessionID: session.id, messageID: firstAssistant })
        Database.use((db) =>
          db
            .update(SessionTable)
            .set({ revert: { messageID: firstUser, partID: PartID.make("prt_part_revert") } })
            .where(eq(SessionTable.id, session.id))
            .run(),
        )

        const result = aggregateSessionFromTurns({ sessionID: session.id })

        expect(result).toMatchObject({ kind: "captured", files: [{ path: "part-kept.txt" }] })
      },
    })
  })

  test("aggregateSessionFromTurns excludes later assistants in a part-level revert window", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "union-session-part-revert-assistant-cutoff" })
        const userMessageID = await makeUser(session.id, "union-session-part-revert-assistant-cutoff")
        const firstAssistant = await makeAssistant(session.id, userMessageID, "part-cutoff-a1")
        const secondAssistant = await makeAssistant(session.id, userMessageID, "part-cutoff-a2")

        recordWrite({
          sessionID: session.id,
          messageID: firstAssistant,
          path: path.join(fixture.path, "part-a1.txt"),
          before: { exists: false },
          after: { exists: true, content: "a1\n" },
        })
        finalize({ sessionID: session.id, messageID: firstAssistant })
        recordWrite({
          sessionID: session.id,
          messageID: secondAssistant,
          path: path.join(fixture.path, "part-a2.txt"),
          before: { exists: false },
          after: { exists: true, content: "a2\n" },
        })
        finalize({ sessionID: session.id, messageID: secondAssistant })
        Database.use((db) =>
          db
            .update(SessionTable)
            .set({ revert: { messageID: firstAssistant, partID: PartID.make("prt_part_revert_assistant") } })
            .where(eq(SessionTable.id, session.id))
            .run(),
        )

        const result = aggregateSessionFromTurns({ sessionID: session.id })

        expect(result).toMatchObject({ kind: "captured", files: [{ path: "part-a1.txt" }] })
        expect(
          result.kind === "captured" || result.kind === "mixed" ? result.files.map((file) => file.path) : [],
        ).not.toContain("part-a2.txt")
      },
    })
  })

  test("aggregateSessionFromTurns collapses repeated paths across turns into one net diff", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "union-session-same-path" })
        const firstUser = await makeUser(session.id, "union-session-same-path-first")
        const firstAssistant = await makeAssistant(session.id, firstUser, "union-session-same-path-first")
        const secondUser = await makeUser(session.id, "union-session-same-path-second")
        const secondAssistant = await makeAssistant(session.id, secondUser, "union-session-same-path-second")
        const target = path.join(fixture.path, "same.txt")

        recordWrite({
          sessionID: session.id,
          messageID: firstAssistant,
          path: target,
          before: { exists: true, content: "one\n" },
          after: { exists: true, content: "two\n" },
        })
        finalize({ sessionID: session.id, messageID: firstAssistant })
        recordWrite({
          sessionID: session.id,
          messageID: secondAssistant,
          path: target,
          before: { exists: true, content: "two\n" },
          after: { exists: true, content: "three\n" },
        })
        finalize({ sessionID: session.id, messageID: secondAssistant })

        const result = aggregateSessionFromTurns({ sessionID: session.id })

        expect(result).toMatchObject({ kind: "captured" })
        if (result.kind !== "captured") return
        expect(result.files).toHaveLength(1)
        expect(result.files[0].path).toBe("same.txt")
        expect(result.files[0].patch).toContain("-one")
        expect(result.files[0].patch).toContain("+three")
        expect(result.files[0].patch).not.toContain("+two")
      },
    })
  })

  test("aggregateSessionFromTurns keeps earlier applied same-path diff after later turn undo", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "union-session-same-path-later-undone" })
        const firstUser = await makeUser(session.id, "union-session-same-path-later-undone-first")
        const firstAssistant = await makeAssistant(session.id, firstUser, "union-session-same-path-later-undone-first")
        const secondUser = await makeUser(session.id, "union-session-same-path-later-undone-second")
        const secondAssistant = await makeAssistant(
          session.id,
          secondUser,
          "union-session-same-path-later-undone-second",
        )
        const target = path.join(fixture.path, "same-undone.txt")
        await fs.writeFile(target, "A\n", "utf-8")

        await fs.writeFile(target, "B\n", "utf-8")
        recordWrite({
          sessionID: session.id,
          messageID: firstAssistant,
          path: target,
          before: { exists: true, content: "A\n" },
          after: { exists: true, content: "B\n" },
        })
        finalize({ sessionID: session.id, messageID: firstAssistant })
        await fs.writeFile(target, "C\n", "utf-8")
        recordWrite({
          sessionID: session.id,
          messageID: secondAssistant,
          path: target,
          before: { exists: true, content: "B\n" },
          after: { exists: true, content: "C\n" },
        })
        finalize({ sessionID: session.id, messageID: secondAssistant })
        await undo({ sessionID: session.id, messageID: secondAssistant })

        const result = aggregateSessionFromTurns({ sessionID: session.id })

        expect(await fs.readFile(target, "utf-8")).toBe("B\n")
        expect(result).toMatchObject({ kind: "captured" })
        if (result.kind !== "captured") return
        expect(result.files).toHaveLength(1)
        expect(result.files[0]).toMatchObject({ path: "same-undone.txt", restoreState: "applied" })
        expect(result.files[0].patch).toContain("-A")
        expect(result.files[0].patch).toContain("+B")
        expect(result.files[0].patch).not.toContain("+C")
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

        recordWrite({
          sessionID: session.id,
          messageID: a1,
          path: fileA,
          before: { exists: false },
          after: { exists: true, content: "newA\n" },
        })
        finalize({ sessionID: session.id, messageID: a1 })
        recordWrite({
          sessionID: session.id,
          messageID: a2,
          path: fileB,
          before: { exists: false },
          after: { exists: true, content: "newB\n" },
        })
        finalize({ sessionID: session.id, messageID: a2 })

        const result = await aggregateTurnUndo({ sessionID: session.id, userMessageID })
        expect(result.status).toBe("applied")
        if (result.status !== "applied") return
        expect(result.display.undoAvailable).toBe(false)
        expect(result.display.redoAvailable).toBe(true)
        expect(
          await fs
            .access(fileA)
            .then(() => true)
            .catch(() => false),
        ).toBe(false)
        expect(
          await fs
            .access(fileB)
            .then(() => true)
            .catch(() => false),
        ).toBe(false)
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

        recordWrite({
          sessionID: session.id,
          messageID: a1,
          path: fileA,
          before: { exists: false },
          after: { exists: true, content: "newA\n" },
        })
        finalize({ sessionID: session.id, messageID: a1 })

        const undoResult = await aggregateTurnUndo({ sessionID: session.id, userMessageID })
        expect(undoResult.status).toBe("applied")
        const redoResult = await aggregateTurnRedo({ sessionID: session.id, userMessageID })
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

        recordWrite({
          sessionID: session.id,
          messageID: a1,
          path: ok,
          before: { exists: false },
          after: { exists: true, content: "newOK\n" },
        })
        finalize({ sessionID: session.id, messageID: a1 })
        recordWrite({
          sessionID: session.id,
          messageID: a2,
          path: conflict,
          before: { exists: false },
          after: { exists: true, content: "expectedConflict\n" },
        })
        finalize({ sessionID: session.id, messageID: a2 })

        const result = await aggregateTurnUndo({ sessionID: session.id, userMessageID })
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
        recordWrite({
          sessionID: session.id,
          messageID: a1,
          path: target,
          before: { exists: false },
          after: { exists: true, content: "two\n" },
        })
        finalize({ sessionID: session.id, messageID: a1 })

        await fs.writeFile(target, "three\n", "utf-8")
        recordWrite({
          sessionID: session.id,
          messageID: a2,
          path: target,
          before: { exists: true, content: "two\n" },
          after: { exists: true, content: "three\n" },
        })
        finalize({ sessionID: session.id, messageID: a2 })

        const result = await aggregateTurnUndo({ sessionID: session.id, userMessageID })
        expect(result.status).toBe("applied")
        if (result.status !== "applied") return
        expect(result.skipped ?? []).toEqual([])
        expect(
          await fs
            .access(target)
            .then(() => true)
            .catch(() => false),
        ).toBe(false)

        const redo = await aggregateTurnRedo({ sessionID: session.id, userMessageID })
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

        recordWrite({
          sessionID: session.id,
          messageID: a1,
          path: fileA,
          before: { exists: false },
          after: { exists: true, content: "A\n" },
        })
        finalize({ sessionID: session.id, messageID: a1 })
        recordWrite({
          sessionID: session.id,
          messageID: a2,
          path: fileB,
          before: { exists: false },
          after: { exists: true, content: "B\n" },
        })
        finalize({ sessionID: session.id, messageID: a2 })

        const display = aggregateTurn({ sessionID: session.id, userMessageID })
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

        recordWrite({
          sessionID: session.id,
          messageID: a1,
          path: fileA,
          before: { exists: false },
          after: { exists: true, content: "A\n" },
        })
        finalize({ sessionID: session.id, messageID: a1 })
        recordWrite({
          sessionID: session.id,
          messageID: a2,
          path: fileB,
          before: { exists: false },
          after: { exists: true, content: "B\n" },
        })
        finalize({ sessionID: session.id, messageID: a2 })

        const undoSecond = await undo({ sessionID: session.id, messageID: a2 })
        expect(undoSecond.status).toBe("applied")

        const display = aggregateTurn({ sessionID: session.id, userMessageID })
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

        recordWrite({
          sessionID: session.id,
          messageID: a1,
          path: ok,
          before: { exists: false },
          after: { exists: true, content: "OK\n" },
        })
        finalize({ sessionID: session.id, messageID: a1 })
        recordWrite({
          sessionID: session.id,
          messageID: a2,
          path: conflict,
          before: { exists: false },
          after: { exists: true, content: "expectedConflict\n" },
        })
        finalize({ sessionID: session.id, messageID: a2 })

        const result = await aggregateTurnUndo({
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

  test("opaque external basenames from sibling assistants disambiguate after aggregation", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "ext-collide" })
        const userMessageID = await makeUser(session.id, "ext")
        const a1 = await makeAssistant(session.id, userMessageID, "ext-a1")
        const a2 = await makeAssistant(session.id, userMessageID, "ext-a2")

        // Two opaque external paths sharing a basename, recorded by different assistants
        // (so per-message disambiguation cannot see the collision).
        const externalA = "/tmp/pawwork-fixture-A/config.json"
        const externalB = "/tmp/pawwork-fixture-B/config.json"

        recordWrite({
          sessionID: session.id,
          messageID: a1,
          path: externalA,
          before: { exists: false },
          after: { exists: true, content: '{"a":1}\n' },
        })
        finalize({ sessionID: session.id, messageID: a1 })
        recordWrite({
          sessionID: session.id,
          messageID: a2,
          path: externalB,
          before: { exists: false },
          after: { exists: true, content: '{"b":1}\n' },
        })
        finalize({ sessionID: session.id, messageID: a2 })

        const display = aggregateTurn({ sessionID: session.id, userMessageID })
        expect(display?.files).toHaveLength(2)
        const paths = (display?.files ?? []).map((f) => f.path)
        // Distinct displayPaths after the second-pass disambiguation.
        expect(new Set(paths).size).toBe(2)
        // At least one entry retains the basename, the other is suffixed with `· external #`.
        expect(paths.some((p) => p === "config.json")).toBe(true)
        expect(paths.some((p) => p.startsWith("config.json · external #"))).toBe(true)
      },
    })
  })

  test("preflight returns fatal unsupported_size when any assistant has an unrestorable target", async () => {
    await resetDatabase()
    await using fixture = await tmpdir()
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "agg-unsupported" })
        const userMessageID = await makeUser(session.id, "u1")
        const a1 = await makeAssistant(session.id, userMessageID, "u-a1")
        const a2 = await makeAssistant(session.id, userMessageID, "u-a2")
        const ok = path.join(fixture.path, "u-ok.txt")
        const big = path.join(fixture.path, "u-big.bin")
        await fs.writeFile(ok, "OK\n", "utf-8")

        recordWrite({
          sessionID: session.id,
          messageID: a1,
          path: ok,
          before: { exists: false },
          after: { exists: true, content: "OK\n" },
        })
        finalize({ sessionID: session.id, messageID: a1 })
        // Mark the second message's `before` as non-restorable (oversized).
        recordWrite({
          sessionID: session.id,
          messageID: a2,
          path: big,
          before: { exists: true, restorable: false, hash: "large:99999999", large: true },
          after: { exists: true, content: "after\n" },
        })
        finalize({ sessionID: session.id, messageID: a2 })

        // Default (force=false): fatal unsupported_size, ok file untouched.
        const blocked = await aggregateTurnUndo({ sessionID: session.id, userMessageID })
        expect(blocked.status).toBe("blocked")
        if (blocked.status !== "blocked") return
        expect(blocked.reason).toBe("unsupported_size")
        expect(await fs.readFile(ok, "utf-8")).toBe("OK\n")

        // force=true must not partially mutate either; still fatal unsupported_size.
        const forced = await aggregateTurnUndo({
          sessionID: session.id,
          userMessageID,
          force: true,
        })
        expect(forced.status).toBe("blocked")
        if (forced.status !== "blocked") return
        expect(forced.reason).toBe("unsupported_size")
        expect(await fs.readFile(ok, "utf-8")).toBe("OK\n")
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

        recordWrite({
          sessionID: session.id,
          messageID: a1,
          path: ok,
          before: { exists: false },
          after: { exists: true, content: "newOK\n" },
        })
        finalize({ sessionID: session.id, messageID: a1 })
        recordWrite({
          sessionID: session.id,
          messageID: a2,
          path: conflict,
          before: { exists: false },
          after: { exists: true, content: "expectedConflict\n" },
        })
        finalize({ sessionID: session.id, messageID: a2 })

        const result = await aggregateTurnUndo({
          sessionID: session.id,
          userMessageID,
          force: true,
        })
        expect(result.status).toBe("applied")
        if (result.status !== "applied") return
        expect(result.skipped?.length ?? 0).toBeGreaterThan(0)
        // a1's file undone (deleted)
        expect(
          await fs
            .access(ok)
            .then(() => true)
            .catch(() => false),
        ).toBe(false)
        // conflict file left as-is
        expect(await fs.readFile(conflict, "utf-8")).toBe("tampered\n")
      },
    })
  })
})
