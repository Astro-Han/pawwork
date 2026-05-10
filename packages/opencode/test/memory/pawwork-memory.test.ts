import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { MemoryFile } from "../../src/memory/memory"
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

  test("keeps Archive as freeform markdown", () => {
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
    expect(parsed.archive).toContain("scope:project")
    expect(parsed.archive).toContain("Project memory.")
  })

  test("allows Archive entries without metadata", () => {
    const parsed = MemoryFile.parse(`# PawWork Memory

## Profile

## Archive

### 2026-05-10 Decision
Use one global MEMORY.md file.
`)
    expect(parsed.status).toBe("ok")
    if (parsed.status !== "ok") throw new Error("expected ok parse")
    expect(parsed.archive).toContain("Use one global MEMORY.md")
  })

  test("does not split Archive entries on markdown body headings", () => {
    const parsed = MemoryFile.parse(`
# PawWork Memory

## Profile

## Archive

### 2026-05-10T18:00:00+09:00 id:mem_markdown scope:user
Remember this:
### Body heading
Still the same entry.
`)
    expect(parsed.status).toBe("ok")
    if (parsed.status !== "ok") throw new Error("expected ok parse")
    expect(parsed.archive).toContain("### Body heading")
    expect(parsed.archive).toContain("Still the same entry.")
  })

  test("does not safe-mode on old or malformed Archive metadata", () => {
    const parsed = MemoryFile.parse(`
# PawWork Memory

## Profile

## Archive

### 2026-05-10T18:00:00+09:00 id:mem_bad scope:global
Bad entry.
`)
    expect(parsed.status).toBe("ok")
    if (parsed.status !== "ok") throw new Error("expected ok parse")
    expect(parsed.archive).toContain("scope:global")
  })

  test("parses Profile-only startup state without parsing Archive entries", () => {
    const parsed = MemoryFile.parseProfileOnly(`
# PawWork Memory

## Profile

- Preferred language: Chinese.

## Archive

### not a valid memory entry
This malformed Archive entry should not affect startup.
`)
    expect(parsed.status).toBe("ok")
    if (parsed.status !== "ok") throw new Error("expected ok parse")
    expect(parsed.profile).toContain("Preferred language")
  })

  test("Profile-only startup still enforces the top-level section contract", () => {
    const parsed = MemoryFile.parseProfileOnly("# PawWork Memory\n\n## Archive\n\n## Profile\n")
    expect(parsed.status).toBe("safe_mode")
    if (parsed.status !== "safe_mode") throw new Error("expected safe mode")
    expect(parsed.reason).toBe("sections_out_of_order")
  })
})

describe("PawWork memory service", () => {
  test("creates default MEMORY.md under PawWork home", async () => {
    await using tmp = await tmpdir()
    const dir = tmp.path
    const service = MemoryService.createForTest({ home: dir, workspacePath: "/repo/pawwork" })
    const state = await service.read()
    expect(state.status).toBe("ok")
    expect(await fs.readFile(path.join(dir, "memory", "MEMORY.md"), "utf8")).toContain("## Profile")
  })

  test("create save read delete smoke path", async () => {
    await using tmp = await tmpdir()
    const dir = tmp.path
    const service = MemoryService.createForTest({ home: dir, workspacePath: "/repo/pawwork" })
    await service.read()
    await service.saveRaw(`# PawWork Memory

## Profile

- PawWork uses one MEMORY.md file.

## Archive

### 2026-05-10 id:mem_manual
Historical note.
`)
    const saved = await service.read()
    expect(saved.content).toContain("mem_manual")
    await service.deleteEntry("mem_manual")
    const deleted = await service.read()
    expect(deleted.content).not.toContain("mem_manual")
  })

  test("serializes concurrent raw saves", async () => {
    await using tmp = await tmpdir()
    const service = MemoryService.createForTest({ home: tmp.path, workspacePath: "/repo/pawwork" })
    await service.read()
    await Promise.all([
      service.saveRaw("# PawWork Memory\n\n## Profile\n\n- First memory.\n\n## Archive\n"),
      service.saveRaw("# PawWork Memory\n\n## Profile\n\n- Second memory.\n\n## Archive\n"),
    ])
    const state = await service.read()
    expect(state.content).toContain("## Profile")
    expect(["First memory.", "Second memory."].some((value) => state.content.includes(value))).toBe(true)
  })

  test("disabled runtime Profile read does not create or parse MEMORY.md", async () => {
    await using tmp = await tmpdir()
    const memoryDir = path.join(tmp.path, "memory")
    await fs.mkdir(memoryDir, { recursive: true })
    await fs.writeFile(path.join(memoryDir, ".disabled"), "disabled\n")

    const service = MemoryService.createForTest({ home: tmp.path, workspacePath: "/repo/pawwork" })
    const state = await service.readProfile()

    expect(state.disabled).toBe(true)
    expect(state.status).toBe("ok")
    await expect(fs.access(path.join(memoryDir, "MEMORY.md"))).rejects.toThrow()
  })

  test("runtime Profile read ignores malformed Archive entries", async () => {
    await using tmp = await tmpdir()
    const service = MemoryService.createForTest({ home: tmp.path, workspacePath: "/repo/pawwork" })
    await service.saveRaw(`
# PawWork Memory

## Profile

- Runtime profile survives malformed Archive.

## Archive

### invalid archive heading
This entry is not parseable by full Archive parsing.
`)

    const state = await service.readProfile()
    expect(state.status).toBe("ok")
    expect(state.profile).toContain("Runtime profile survives")
  })
})
