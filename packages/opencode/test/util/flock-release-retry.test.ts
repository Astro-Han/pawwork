import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { tmpdir } from "../fixture/fixture"

async function importFlockWithTransientReleaseFailure(root: string, tempDir: string) {
  const source = path.join(root, "src", "util", "flock.ts")
  await fs.mkdir(tempDir, { recursive: true })

  const mockFsPath = path.join(tempDir, "mock-fs-promises.ts")
  const flockPath = path.join(tempDir, "flock-under-test.ts")
  const original = await fs.readFile(source, "utf8")
  const globalUrl = pathToFileURL(path.join(root, "src", "global", "index.ts")).href
  const hashUrl = pathToFileURL(path.join(root, "src", "util", "hash.ts")).href

  await fs.writeFile(
    mockFsPath,
    [
      'import * as real from "fs/promises"',
      'export const mkdir = real.mkdir',
      'export const readFile = real.readFile',
      'export const stat = real.stat',
      'export const utimes = real.utimes',
      'export const writeFile = real.writeFile',
      "",
      "let failed = false",
      "",
      "export async function rm(target: Parameters<typeof real.rm>[0], options?: Parameters<typeof real.rm>[1]) {",
      '  if (!failed && typeof target === "string" && target.endsWith(".lock")) {',
      "    failed = true",
      '    const error = new Error("transient lock-dir removal failure") as Error & { code?: string }',
      '    error.code = "ENOTEMPTY"',
      "    throw error",
      "  }",
      "  return real.rm(target, options)",
      "}",
      "",
    ].join("\n"),
    "utf8",
  )

  await fs.writeFile(
    flockPath,
    original
      .replace('from "fs/promises"', 'from "./mock-fs-promises.ts"')
      .replace('from "@/global"', `from "${globalUrl}"`)
      .replace('from "@/util/hash"', `from "${hashUrl}"`),
    "utf8",
  )

  return import(pathToFileURL(flockPath).href + `?t=${Date.now()}`)
}

describe("util.flock release retry", () => {
  test("retries transient lock-dir removal failures during release", async () => {
    await using tmp = await tmpdir()
    const root = path.join(import.meta.dir, "../..")
    const { Flock } = await importFlockWithTransientReleaseFailure(root, path.join(tmp.path, "module-fixtures"))
    const dir = path.join(tmp.path, "locks")
    const key = "flock:release-retry"

    const lease = await Flock.acquire(key, {
      dir,
      staleMs: 1_000,
      timeoutMs: 1_000,
      baseDelayMs: 10,
      maxDelayMs: 20,
    })

    await expect(lease.release()).resolves.toBeUndefined()

    let reacquired = false
    await Flock.withLock(
      key,
      async () => {
        reacquired = true
      },
      {
        dir,
        staleMs: 1_000,
        timeoutMs: 1_000,
        baseDelayMs: 10,
        maxDelayMs: 20,
      },
    )

    expect(reacquired).toBe(true)
  })
})
