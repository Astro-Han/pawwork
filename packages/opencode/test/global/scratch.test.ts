import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { sweepScratch } from "@/global/scratch"

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

async function setMtime(file: string, ms: number) {
  const t = new Date(ms)
  await fs.utimes(file, t, t)
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target)
    return true
  } catch {
    return false
  }
}

// Tests that exercise the *removal* path advance the injected `now` into the
// future rather than ageing files with utimes: a freshly created entry keeps a
// recent ctime, and sweepScratch uses max(mtime, ctime), so the only portable
// way to make an entry read as stale is to move the clock past it.
describe("sweepScratch", () => {
  test("removes a top-level entry untouched past the window", async () => {
    await using dir = await tmpdir()
    const created = Date.now()
    const stale = path.join(dir.path, "draft.md")
    await fs.writeFile(stale, "old pr draft")

    await sweepScratch({ dir: dir.path, now: created + 2 * DAY, maxAgeMs: DAY })

    expect(await exists(stale)).toBe(false)
  })

  test("keeps a recently modified file", async () => {
    await using dir = await tmpdir()
    const fresh = path.join(dir.path, "draft.md")
    await fs.writeFile(fresh, "active pr draft")

    await sweepScratch({ dir: dir.path, now: Date.now(), maxAgeMs: DAY })

    expect(await exists(fresh)).toBe(true)
  })

  test("keeps a file with old mtime but recent ctime (cp -p / unzip)", async () => {
    await using dir = await tmpdir()
    const fresh = path.join(dir.path, "restored.patch")
    await fs.writeFile(fresh, "just created")
    // Restore mtime far into the past; ctime stays ~now because the inode just changed.
    await setMtime(fresh, Date.now() - 10 * DAY)

    await sweepScratch({ dir: dir.path, now: Date.now(), maxAgeMs: DAY })

    expect(await exists(fresh)).toBe(true)
  })

  test("keeps a stale directory that holds one fresh nested file", async () => {
    await using dir = await tmpdir()
    const created = Date.now()
    const sub = path.join(dir.path, "work")
    await fs.mkdir(sub, { recursive: true })
    const oldFile = path.join(sub, "old.log")
    const liveFile = path.join(sub, "live.log")
    await fs.writeFile(oldFile, "old")
    await fs.writeFile(liveFile, "live")
    // One nested file modified well after the (future) cutoff keeps the subtree.
    await setMtime(liveFile, created + 10 * DAY)

    await sweepScratch({ dir: dir.path, now: created + 2 * DAY, maxAgeMs: DAY })

    expect(await exists(sub)).toBe(true)
    expect(await exists(liveFile)).toBe(true)
  })

  test("removes a directory whose whole subtree is stale", async () => {
    await using dir = await tmpdir()
    const created = Date.now()
    const sub = path.join(dir.path, "work")
    await fs.mkdir(sub, { recursive: true })
    await fs.writeFile(path.join(sub, "old.log"), "old")

    await sweepScratch({ dir: dir.path, now: created + 2 * DAY, maxAgeMs: DAY })

    expect(await exists(sub)).toBe(false)
  })

  test("removes a stale symlink without following it to its target", async () => {
    await using dir = await tmpdir()
    await using outside = await tmpdir()
    const created = Date.now()
    const target = path.join(outside.path, "keep.txt")
    await fs.writeFile(target, "external data")
    const link = path.join(dir.path, "link")
    await fs.symlink(target, link)

    await sweepScratch({ dir: dir.path, now: created + 2 * DAY, maxAgeMs: DAY })

    expect(await exists(link)).toBe(false)
    expect(await exists(target)).toBe(true)
  })

  test("is a no-op for a missing directory", async () => {
    await using dir = await tmpdir()
    const missing = path.join(dir.path, "does-not-exist")
    await expect(sweepScratch({ dir: missing, now: Date.now(), maxAgeMs: DAY })).resolves.toBeUndefined()
  })
})
