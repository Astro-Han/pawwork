import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { MemoryFile } from "../../src/memory/memory"
import { MemoryProposal } from "../../src/memory/proposal"
import { MemoryService } from "../../src/memory/service"

describe("PawWork memory parser", () => {
  test("parses the default Profile and Archive sections", () => {
    const parsed = MemoryFile.parse(MemoryFile.defaultTemplate())
    expect(parsed.status).toBe("ok")
    if (parsed.status !== "ok") throw new Error("expected ok parse")
    expect(parsed.profile.trim()).toContain("PawWork Memory")
    expect(parsed.archive.trim()).toBe("")
  })

  test("enters safe mode when Profile is missing", () => {
    const parsed = MemoryFile.parse("# PawWork Memory\n\n## Archive\n")
    expect(parsed.status).toBe("safe_mode")
    if (parsed.status !== "safe_mode") throw new Error("expected safe mode")
    expect(parsed.reason).toBe("missing_profile")
  })

  test("enters safe mode when Archive appears before Profile", () => {
    const parsed = MemoryFile.parse("# PawWork Memory\n\n## Archive\n\n## Profile\n")
    expect(parsed.status).toBe("safe_mode")
    if (parsed.status !== "safe_mode") throw new Error("expected safe mode")
    expect(parsed.reason).toBe("sections_out_of_order")
  })

  test("parses Archive entries with user and project scopes only", () => {
    const parsed = MemoryFile.parse(`
# PawWork Memory

## Profile

- Preferred language: Chinese.

## Archive

### 2026-05-10T18:00:00+09:00 id:mem_abc scope:project applies_to:/repo/pawwork
Project memory.
`)
    expect(parsed.status).toBe("ok")
    if (parsed.status !== "ok") throw new Error("expected ok parse")
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.entries[0]?.id).toBe("mem_abc")
    expect(parsed.entries[0]?.scope).toBe("project")
  })

  test("marks global scope invalid in v1", () => {
    const parsed = MemoryFile.parse(`
# PawWork Memory

## Profile

## Archive

### 2026-05-10T18:00:00+09:00 id:mem_bad scope:global
Bad entry.
`)
    expect(parsed.status).toBe("ok")
    if (parsed.status !== "ok") throw new Error("expected ok parse")
    expect(parsed.entries).toHaveLength(0)
    expect(parsed.invalidEntries).toHaveLength(1)
  })
})

describe("PawWork memory service", () => {
  test("creates default MEMORY.md under PawWork home", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pawwork-memory-"))
    const service = MemoryService.createForTest({ home: dir, workspacePath: "/repo/pawwork" })
    const state = await service.read()
    expect(state.status).toBe("ok")
    expect(await fs.readFile(path.join(dir, "memory", "MEMORY.md"), "utf8")).toContain("## Profile")
  })

  test("redacts high-risk tokens and defaults proposal to unselected", () => {
    const proposal = MemoryProposal.fromText({ text: "Use token sk-test123456" })
    expect(proposal.text).toContain("[REDACTED]")
    expect(proposal.defaultSelected).toBe(false)
    expect(proposal.warning).toContain("sensitive")
  })

  test("create append read delete smoke path", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pawwork-memory-"))
    const service = MemoryService.createForTest({ home: dir, workspacePath: "/repo/pawwork" })
    await service.read()
    await service.appendAcceptedProposal({ text: "PawWork uses one MEMORY.md file.", scope: "project" })
    const appended = await service.read()
    expect(appended.content).toContain("scope:project")
    const id = appended.content.match(/id:(mem_[a-z0-9]+)/)?.[1]
    expect(id).toBeTruthy()
    await service.deleteEntry(id!)
    const deleted = await service.read()
    expect(deleted.content).not.toContain(id!)
  })
})
