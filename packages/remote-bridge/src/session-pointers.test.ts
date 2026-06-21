import { test, expect } from "bun:test"
import { chmod, mkdtemp, readdir, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
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

test("write queue treats relative and absolute paths as the same state file", async () => {
  const path = await tempFile()
  const cwd = process.cwd()
  process.chdir(dirname(path))
  try {
    const first = await SessionPointers.fromFile(basename(path))
    const second = await SessionPointers.fromFile(path)
    const writes: Promise<void>[] = []
    for (let n = 0; n < 100; n++) {
      writes.push(first.set(`feishu:dm:relative-${n}`, `ses_relative_${n}`))
      writes.push(second.set(`feishu:dm:absolute-${n}`, `ses_absolute_${n}`))
    }
    await Promise.all(writes)
    await expect(SessionPointers.fromFile(path)).resolves.toBeDefined()
    const leftovers = (await readdir(dirname(path))).filter((f) => f.endsWith(".tmp"))
    expect(leftovers).toEqual([])
  } finally {
    process.chdir(cwd)
  }
})

// POSIX-only: Windows does not carry owner/group/other mode bits.
test.skipIf(process.platform === "win32")("persists the state file with owner-only permissions", async () => {
  const path = await tempFile()
  const pointers = await SessionPointers.fromFile(path)
  await pointers.set("feishu:dm:alice", "ses_1")
  const info = await stat(path)
  expect(info.mode & 0o777).toBe(0o600)
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

test("clearPlatform drops one platform's mappings but keeps the cursor and other platforms", async () => {
  const pointers = SessionPointers.memory()
  await pointers.set("wechat:dm:u1", "ses_wx_a")
  await pointers.set("wechat:dm:u2", "ses_wx_b")
  await pointers.set("telegram:dm:t1", "ses_tg")
  await pointers.setEventCursor("cursor-123")

  await pointers.clearPlatform("wechat")

  expect(pointers.get("wechat:dm:u1")).toBe("")
  expect(pointers.get("wechat:dm:u2")).toBe("")
  expect(pointers.get("telegram:dm:t1")).toBe("ses_tg") // a sibling platform is untouched
  expect(pointers.eventCursor()).toBe("cursor-123") // the global cursor survives
})

test("clearPlatform persists the pruned set to disk", async () => {
  const path = await tempFile()
  const pointers = await SessionPointers.fromFile(path)
  await pointers.set("wechat:dm:u1", "ses_wx")
  await pointers.set("telegram:dm:t1", "ses_tg")
  await pointers.clearPlatform("wechat")

  const reloaded = await SessionPointers.fromFile(path)
  expect(reloaded.get("wechat:dm:u1")).toBe("")
  expect(reloaded.get("telegram:dm:t1")).toBe("ses_tg")
})

test("a clearPlatform whose disk write fails leaves the stale pointer to revive on restart", async () => {
  // removePlatform's pointer cleanup is best-effort: clearPlatform prunes the in-memory map and
  // then writes atomically (unique temp + rename), so a write failure leaves memory pruned but the
  // on-disk snapshot intact. If the app exits before any later save heals the file, the next launch
  // reloads the stale mapping — and a reconnect of the same platform (addPlatform keeps pointers)
  // resurfaces it. This pins that accepted behavior so a future reader knows it is deliberate, not a
  // latent bug; a self-healing tombstone is tracked as follow-up, not blocking the incremental path.
  if (process.getuid?.() === 0) return // a read-only dir cannot block root; skip the forced failure
  const path = await tempFile()
  const live = await SessionPointers.fromFile(path)
  await live.set("wechat:dm:u1", "ses_wx")
  await live.set("telegram:dm:t1", "ses_tg")

  // Freeze the directory so the next atomic write cannot create its temp file; the existing
  // snapshot is left untouched (the rename never runs).
  const dir = dirname(path)
  await chmod(dir, 0o500)
  try {
    await expect(live.clearPlatform("wechat")).rejects.toBeDefined() // the write failed
    expect(live.get("wechat:dm:u1")).toBe("") // but the in-memory map was already pruned
  } finally {
    await chmod(dir, 0o700) // restore so the snapshot stays intact and the dir is cleanable
  }

  // Restart: the on-disk snapshot never lost wechat, so reloading it (a reconnect of the same
  // platform) revives the stale pointer.
  const reloaded = await SessionPointers.fromFile(path)
  expect(reloaded.get("wechat:dm:u1")).toBe("ses_wx") // stale pointer revived after restart
  expect(reloaded.get("telegram:dm:t1")).toBe("ses_tg")
})
