import { afterEach, describe, expect, mock, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session as SessionNs } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { TurnChange } from "../../src/session/turn-change"
import { MessageID, type SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Log } from "@opencode-ai/core/util/log"
import { tmpdir } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"

void Log.init({ print: false })

afterEach(async () => {
  mock.restore()
  await Instance.disposeAll()
})

async function makeUser(sessionID: SessionID, suffix: string) {
  const id = MessageID.make(`msg_user_${suffix}`)
  await SessionNs.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test") },
  } as unknown as MessageV2.Info)
  return id
}

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

describe("turn-change aggregate HTTP routes (#428)", () => {
  test("GET aggregates two assistant edits, undo applies and redo restores", async () => {
    await resetDatabase()
    await using fixture = await tmpdir({ git: true })
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "agg-route" })
        const userMessageID = await makeUser(session.id, "agg-route")
        const a1 = await makeAssistant(session.id, userMessageID, "agg-route-a1")
        const a2 = await makeAssistant(session.id, userMessageID, "agg-route-a2")

        const fileA = path.join(fixture.path, "alpha.txt")
        const fileB = path.join(fixture.path, "beta.txt")
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

        const app = Server.Default().app

        const getRes = await app.request(`/session/${session.id}/turn/${userMessageID}/changes`)
        expect(getRes.status).toBe(200)
        const display = await getRes.json()
        expect(display).toBeTruthy()
        expect(display.kind).toBe("captured")
        expect(display.files.map((f: { path: string }) => f.path)).toEqual(["alpha.txt", "beta.txt"])
        expect(display.files.map((f: { restoreState: string }) => f.restoreState)).toEqual(["applied", "applied"])

        const undoRes = await app.request(`/session/${session.id}/turn/${userMessageID}/changes/undo`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })
        expect(undoRes.status).toBe(200)
        const undoBody = await undoRes.json()
        expect(undoBody.status).toBe("applied")
        expect(undoBody.display.undoAvailable).toBe(false)
        expect(undoBody.display.redoAvailable).toBe(true)
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

        const redoRes = await app.request(`/session/${session.id}/turn/${userMessageID}/changes/redo`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })
        expect(redoRes.status).toBe(200)
        const redoBody = await redoRes.json()
        expect(redoBody.status).toBe("applied")
        expect(redoBody.display.undoAvailable).toBe(true)
        expect(redoBody.display.redoAvailable).toBe(false)
        expect(await fs.readFile(fileA, "utf-8")).toBe("A\n")
        expect(await fs.readFile(fileB, "utf-8")).toBe("B\n")
      },
    })
  })

  test("POST undo without force is blocked on conflict; force=true applies and reports skipped", async () => {
    await resetDatabase()
    await using fixture = await tmpdir({ git: true })
    await Instance.provide({
      directory: fixture.path,
      fn: async () => {
        const session = await SessionNs.create({ title: "agg-route-conflict" })
        const userMessageID = await makeUser(session.id, "conflict")
        const a1 = await makeAssistant(session.id, userMessageID, "cf-a1")
        const a2 = await makeAssistant(session.id, userMessageID, "cf-a2")

        const ok = path.join(fixture.path, "ok.txt")
        const conflict = path.join(fixture.path, "cnf.txt")
        await fs.writeFile(ok, "ok\n", "utf-8")
        await fs.writeFile(conflict, "tampered\n", "utf-8")

        TurnChange.recordWrite({
          sessionID: session.id,
          messageID: a1,
          path: ok,
          before: { exists: false },
          after: { exists: true, content: "ok\n" },
        })
        TurnChange.finalize({ sessionID: session.id, messageID: a1 })
        TurnChange.recordWrite({
          sessionID: session.id,
          messageID: a2,
          path: conflict,
          before: { exists: false },
          after: { exists: true, content: "expected\n" },
        })
        TurnChange.finalize({ sessionID: session.id, messageID: a2 })

        const app = Server.Default().app

        const blockedRes = await app.request(`/session/${session.id}/turn/${userMessageID}/changes/undo`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        })
        expect(blockedRes.status).toBe(200)
        const blockedBody = await blockedRes.json()
        expect(blockedBody.status).toBe("blocked")
        expect(blockedBody.reason).toBe("conflict")
        expect(await fs.readFile(ok, "utf-8")).toBe("ok\n")
        expect(await fs.readFile(conflict, "utf-8")).toBe("tampered\n")

        const forceRes = await app.request(`/session/${session.id}/turn/${userMessageID}/changes/undo`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force: true }),
        })
        expect(forceRes.status).toBe(200)
        const forceBody = await forceRes.json()
        expect(forceBody.status).toBe("applied")
        expect(Array.isArray(forceBody.skipped)).toBe(true)
        expect(forceBody.skipped.length).toBeGreaterThan(0)
        expect(
          await fs
            .access(ok)
            .then(() => true)
            .catch(() => false),
        ).toBe(false)
        expect(await fs.readFile(conflict, "utf-8")).toBe("tampered\n")
      },
    })
  })
})
