import { test, expect } from "bun:test"
import { mkdtemp, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionPointers } from "./session-pointers.ts"

async function tempFile(name = "sessions.json"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "remote-bridge-"))
  return join(dir, name)
}

test("memory store rejects duplicate root bindings", async () => {
  const pointers = SessionPointers.memory()
  await pointers.set("slack:dm:alice", "ses_root")
  await expect(pointers.set("feishu:chat:ops", "ses_root")).rejects.toThrow()
})

test("memory store rejects a parent that creates a duplicate root", async () => {
  const pointers = SessionPointers.memory()
  await pointers.set("slack:dm:alice", "ses_root")
  await pointers.set("feishu:chat:ops", "ses_child")
  await expect(pointers.setParent("ses_child", "ses_root")).rejects.toThrow()
})

test("memory store rejects a parent cycle and keeps roots intact", async () => {
  const pointers = SessionPointers.memory()
  await pointers.setParent("ses_1", "ses_2")
  await expect(pointers.setParent("ses_2", "ses_1")).rejects.toThrow()
  expect(pointers.rootSession("ses_1")).toBe("ses_2")
  expect(pointers.rootSession("ses_2")).toBe("ses_2")
})

test("file store does not restore ambiguous root bindings", async () => {
  const path = await tempFile()
  await writeFile(
    path,
    JSON.stringify({
      sessions: { "slack:dm:alice": "ses_root", "feishu:chat:ops": "ses_child" },
      parents: { ses_child: "ses_root" },
    }),
  )
  const pointers = await SessionPointers.fromFile(path)
  expect(pointers.remoteKeyForSession("ses_child")).toBe("")
})

test("concurrent writes from two stores leave a valid state with no temp leftovers", async () => {
  const path = await tempFile()
  const first = await SessionPointers.fromFile(path)
  const second = await SessionPointers.fromFile(path)

  const drive = (store: SessionPointers, id: number) => {
    const work: Promise<void>[] = []
    for (let n = 0; n < 200; n++) {
      work.push(store.set(`slack:dm:${id}-${n}`, `ses_${id}_${n}`))
      work.push(store.setEventCursor(`cursor-${id}-${n}`))
    }
    return Promise.all(work)
  }
  await Promise.all([drive(first, 0), drive(second, 1)])

  // Surviving file must still be a complete, parseable snapshot.
  await expect(SessionPointers.fromFile(path)).resolves.toBeDefined()
  const leftovers = (await readdir(join(path, ".."))).filter((f) => f.endsWith(".tmp"))
  expect(leftovers).toEqual([])
})

test("file store loads the legacy bare-map format written by an early build", async () => {
  const path = await tempFile()
  // Pre-wrapper builds persisted just {"<remoteKey>":"<sessionID>"}; an upgrade
  // must keep those bindings instead of silently starting empty.
  await writeFile(path, JSON.stringify({ "feishu:dm:alice": "ses_1", "slack:dm:bob": "ses_2" }))

  const pointers = await SessionPointers.fromFile(path)
  expect(pointers.get("feishu:dm:alice")).toBe("ses_1")
  expect(pointers.get("slack:dm:bob")).toBe("ses_2")
})

test("file store persists the event cursor alongside sessions", async () => {
  const path = await tempFile()
  const pointers = await SessionPointers.fromFile(path)
  await pointers.set("feishu:dm:alice", "ses_1")
  await pointers.setEventCursor("cursor-2")

  const reloaded = await SessionPointers.fromFile(path)
  expect(reloaded.get("feishu:dm:alice")).toBe("ses_1")
  expect(reloaded.eventCursor()).toBe("cursor-2")
})
