import { expect, test } from "bun:test"
import { readdir, readFile } from "fs/promises"
import path from "path"

const srcRoot = path.resolve(import.meta.dir, "../../src")

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const filepath = path.join(dir, entry.name)
      if (entry.isDirectory()) return sourceFiles(filepath)
      if (!entry.isFile()) return []
      if (!/\.[cm]?tsx?$/.test(entry.name)) return []
      return [filepath]
    }),
  )
  return files.flat()
}

function relativeSource(file: string) {
  return path.relative(srcRoot, file).split(path.sep).join("/")
}

test("legacy Flock imports stay in explicit Promise lease boundaries", async () => {
  const hits: string[] = []
  for (const file of await sourceFiles(srcRoot)) {
    const text = await readFile(file, "utf8")
    if (/\bfrom\s+["'](?:@\/util\/flock|@opencode-ai\/core\/util\/flock|(?:\.\.\/)+util\/flock)["']/.test(text)) {
      hits.push(relativeSource(file))
    }
  }

  expect(hits.sort()).toEqual(["automation/index.ts", "automation/scheduler.ts"])
})

test("async lazy stays in explicit compatibility boundaries", async () => {
  const hits: string[] = []
  for (const file of await sourceFiles(srcRoot)) {
    const text = await readFile(file, "utf8")
    if (/\blazy\s*\(\s*async\b/.test(text)) hits.push(relativeSource(file))
  }

  expect(hits.sort()).toEqual([])
})

test("production source does not use Promise flock compatibility", async () => {
  const hits: string[] = []
  for (const file of await sourceFiles(srcRoot)) {
    const text = await readFile(file, "utf8")
    if (text.includes("EffectFlock.withLockPromise")) hits.push(relativeSource(file))
  }

  expect(hits.sort()).toEqual([])
})

test("worktree adaptor does not call Worktree Promise facades", async () => {
  const text = await readFile(path.join(srcRoot, "control-plane/adaptors/worktree.ts"), "utf8")

  expect(text).not.toContain("Worktree.makeWorktreeInfo")
  expect(text).not.toContain("Worktree.createFromInfo")
  expect(text).not.toContain("Worktree.remove")
})

test("Worktree service uses the Effect-native gitignore guard boundary", async () => {
  const text = await readFile(path.join(srcRoot, "worktree/index.ts"), "utf8")

  expect(text).not.toContain("Effect.promise(() => ensureWorktreesIgnored")
  expect(text).not.toContain("Effect.promise(() => restoreWorktreesIgnored")
})
