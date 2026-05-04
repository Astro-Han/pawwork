import { beforeEach, test, expect } from "bun:test"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { parse as parseJsonc } from "jsonc-parser"
import { tmpdir } from "../fixture/fixture"
import {
  stripDefaultAgent,
  migrateDefaultAgent,
  _resetFailedPaths,
  _hasFailedPath,
  type MigrationLogger,
} from "../../src/config/migrate-default-agent"

beforeEach(() => {
  _resetFailedPaths()
})

function makeMockLogger() {
  const calls: { level: "debug" | "info" | "warn" | "error"; message: string; extra?: Record<string, any> }[] = []
  const logger: MigrationLogger = {
    debug: (message, extra) => calls.push({ level: "debug", message: String(message), extra }),
    info: (message, extra) => calls.push({ level: "info", message: String(message), extra }),
    warn: (message, extra) => calls.push({ level: "warn", message: String(message), extra }),
    error: (message, extra) => calls.push({ level: "error", message: String(message), extra }),
  }
  return { logger, calls }
}

test("stripDefaultAgent: returns original text + oldValue=undefined when field absent", () => {
  const text = JSON.stringify({ model: "anthropic/claude-opus-4-7" }, null, 2)
  const result = stripDefaultAgent(text)
  expect(result.text).toBe(text)
  expect(result.oldValue).toBeUndefined()
})

test("stripDefaultAgent: removes field from plain JSON, preserves other keys", () => {
  const before = JSON.stringify({ default_agent: "plan", model: "x/y" }, null, 2)
  const result = stripDefaultAgent(before)
  expect(result.oldValue).toBe("plan")
  const parsed = JSON.parse(result.text)
  expect(parsed.default_agent).toBeUndefined()
  expect(parsed.model).toBe("x/y")
})

test("stripDefaultAgent: handles JSONC with comments and trailing commas", () => {
  // jsonc-parser's modify() drops a key together with its leading comment trivia
  // (treated as part of the removed node). Trailing same-line comments and unrelated
  // fields survive. PawWork writes default_agent automatically, so leading-comment
  // loss next to the deprecated field is acceptable best-effort behavior.
  const before = `{
    "default_agent": "plan",
    "model": "anthropic/claude-opus-4-7", // trailing comment
  }`
  const result = stripDefaultAgent(before)
  expect(result.oldValue).toBe("plan")
  expect(result.text).not.toContain("default_agent")
  expect(result.text).toContain("trailing comment")
  // Result must remain valid JSONC and preserve the surviving field
  const reparsed = parseJsonc(result.text, [], { allowTrailingComma: true })
  expect(reparsed.model).toBe("anthropic/claude-opus-4-7")
})

test("stripDefaultAgent: tolerates non-object JSON (returns text unchanged)", () => {
  for (const text of ["[1,2,3]", "null", '"just a string"', "42"]) {
    const result = stripDefaultAgent(text)
    expect(result.text).toBe(text)
    expect(result.oldValue).toBeUndefined()
  }
})

test("migrateDefaultAgent: rewrites a config file containing default_agent (atomic)", async () => {
  await using tmp = await tmpdir()
  const cfgPath = path.join(tmp.path, "pawwork.json")
  await fs.writeFile(cfgPath, JSON.stringify({ default_agent: "plan", model: "x/y" }, null, 2), "utf8")

  const { logger, calls } = makeMockLogger()
  const res = await migrateDefaultAgent(cfgPath, { logger })

  expect(res.rewritten).toBe(true)
  expect(res.sanitizedText).toBeDefined()
  expect(res.sanitizedText).not.toContain("default_agent")

  const after = JSON.parse(await fs.readFile(cfgPath, "utf8"))
  expect(after.default_agent).toBeUndefined()
  expect(after.model).toBe("x/y")

  const infoCalls = calls.filter((c) => c.level === "info" && c.message.includes("migrated deprecated default_agent"))
  expect(infoCalls.length).toBe(1)
  expect(infoCalls[0].extra?.oldValue).toBe("plan")
})

test("migrateDefaultAgent: idempotent — does not modify file when field absent", async () => {
  await using tmp = await tmpdir()
  const cfgPath = path.join(tmp.path, "pawwork.json")
  const original = JSON.stringify({ model: "x/y" }, null, 2)
  await fs.writeFile(cfgPath, original, "utf8")
  const beforeMtime = (await fs.stat(cfgPath)).mtimeMs
  await new Promise((r) => setTimeout(r, 10))

  const { logger } = makeMockLogger()
  const res = await migrateDefaultAgent(cfgPath, { logger })

  expect(res.rewritten).toBe(false)
  expect(res.sanitizedText).toBeUndefined()
  expect((await fs.stat(cfgPath)).mtimeMs).toBe(beforeMtime)
})

test("migrateDefaultAgent: missing config file resolves cleanly", async () => {
  await using tmp = await tmpdir()
  const cfgPath = path.join(tmp.path, "does-not-exist.json")
  const { logger } = makeMockLogger()
  const res = await migrateDefaultAgent(cfgPath, { logger })
  expect(res.rewritten).toBe(false)
})

test("migrateDefaultAgent: write failure → returns sanitizedText for in-memory fallback", async () => {
  await using tmp = await tmpdir()
  const cfgPath = path.join(tmp.path, "pawwork.json")
  await fs.writeFile(cfgPath, JSON.stringify({ default_agent: "plan", model: "x/y" }, null, 2), "utf8")
  const tmpPath = cfgPath + ".migrate.tmp"
  await fs.mkdir(tmpPath, { recursive: true })

  const { logger, calls } = makeMockLogger()
  const res = await migrateDefaultAgent(cfgPath, { logger })

  expect(res.rewritten).toBe(false)
  expect(res.sanitizedText).toBeDefined()
  expect(res.sanitizedText).not.toContain("default_agent")
  expect(_hasFailedPath(cfgPath)).toBe(true)
  expect(calls.some((c) => c.level === "warn" && c.message.includes("could not rewrite"))).toBe(true)

  await fs.rmdir(tmpPath)
})

// POSIX file mode bits do not exist on Windows: NTFS reports a fixed
// 0o666/0o444 mask regardless of the chmod call. Skip the assertion there.
test.skipIf(process.platform === "win32")(
  "migrateDefaultAgent: preserves original file mode (0600 stays 0600)",
  async () => {
    await using tmp = await tmpdir()
    const cfgPath = path.join(tmp.path, "pawwork.json")
    await fs.writeFile(cfgPath, JSON.stringify({ default_agent: "plan", apiKey: "sk-secret" }, null, 2), "utf8")
    await fs.chmod(cfgPath, 0o600)

    const { logger } = makeMockLogger()
    const res = await migrateDefaultAgent(cfgPath, { logger })

    expect(res.rewritten).toBe(true)
    const after = await fs.stat(cfgPath)
    // mask off non-permission bits and assert exact mode preserved
    expect(after.mode & 0o777).toBe(0o600)
  },
)

test("migrateDefaultAgent: subsequent call after failed first still returns sanitizedText", async () => {
  await using tmp = await tmpdir()
  const cfgPath = path.join(tmp.path, "pawwork.json")
  await fs.writeFile(cfgPath, JSON.stringify({ default_agent: "plan" }, null, 2), "utf8")
  const tmpPath = cfgPath + ".migrate.tmp"
  await fs.mkdir(tmpPath, { recursive: true })

  const { logger: logger1 } = makeMockLogger()
  const first = await migrateDefaultAgent(cfgPath, { logger: logger1 })
  expect(first.rewritten).toBe(false)
  expect(first.sanitizedText).toBeDefined()

  await fs.rmdir(tmpPath)

  const { logger: logger2, calls: calls2 } = makeMockLogger()
  const second = await migrateDefaultAgent(cfgPath, { logger: logger2 })
  expect(second.rewritten).toBe(false)
  expect(second.sanitizedText).toBeDefined()
  expect(second.sanitizedText).not.toContain("default_agent")
  const afterDisk = await fs.readFile(cfgPath, "utf8")
  expect(afterDisk).toContain("default_agent")
  expect(calls2.some((c) => c.level === "debug" && c.message.includes("skipping disk rewrite"))).toBe(true)
})
