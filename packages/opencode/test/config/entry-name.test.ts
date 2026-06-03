import { describe, expect, test } from "bun:test"
import { posix } from "path"
import { configEntryNameFromPath } from "@/config/entry-name"

// The prefixes shipped by config/agent.ts after the relative-path refactor.
const AGENT_PREFIXES = ["agent/", "agents/"]

describe("configEntryNameFromPath", () => {
  test("strips an `agents/` prefix and returns the bare name", () => {
    expect(configEntryNameFromPath("agents/build.md", AGENT_PREFIXES)).toBe("build")
  })

  test("strips an `agent/` (singular) prefix", () => {
    expect(configEntryNameFromPath("agent/build.md", AGENT_PREFIXES)).toBe("build")
  })

  test("preserves nested subdirectories in the key", () => {
    expect(configEntryNameFromPath("agents/team/build.md", AGENT_PREFIXES)).toBe("team/build")
  })

  test("normalizes Windows-style backslashes", () => {
    expect(configEntryNameFromPath("agents\\team\\build.md", AGENT_PREFIXES)).toBe("team/build")
  })

  // PawWork-specific: prefix matching is case-insensitive, but the returned key
  // preserves the original casing of the entry name.
  test("matches the prefix case-insensitively and preserves entry casing", () => {
    expect(configEntryNameFromPath("Agents/Build.md", AGENT_PREFIXES)).toBe("Build")
    expect(configEntryNameFromPath("AGENT/Build.md", AGENT_PREFIXES)).toBe("Build")
    expect(configEntryNameFromPath("agents/Team/Build.md", ["AGENTS/"])).toBe("Team/Build")
  })

  test("falls back to basename when no prefix matches", () => {
    expect(configEntryNameFromPath("orphaned.md", AGENT_PREFIXES)).toBe("orphaned")
    expect(configEntryNameFromPath("anywhere/orphaned.md", [])).toBe("orphaned")
  })

  // Regression for #28359 (upstream #25713): a parent/home segment containing
  // `agent` or `agents` used to win the substring match before the real
  // `agents/` directory, leaking the intervening path into the key (e.g.
  // `proj/agent/build`). Anchoring at the caller via `path.relative(dir, item)`
  // makes this impossible — the relative path is always rooted at the prefix.
  test("regression #28359: caller passes relative path; parent /agent/ segment is irrelevant", () => {
    const dir = "/Users/agent/proj"
    const item = "/Users/agent/proj/agent/build.md"
    const relative = posix.relative(dir, item)
    expect(relative).toBe("agent/build.md")
    expect(configEntryNameFromPath(relative, AGENT_PREFIXES)).toBe("build")
  })

  // Anchoring is what makes the relative-path contract safe: a prefix that
  // appears only in a deeper/parent segment of an absolute path is NOT stripped
  // (the helper falls back to the basename). Before #28359 the unanchored
  // substring match returned "proj/agent/build" here.
  test("regression #28359: does not strip from a misleading parent segment", () => {
    expect(configEntryNameFromPath("/Users/agent/proj/agent/build.md", AGENT_PREFIXES)).toBe("build")
  })

  test("regression #28359: parent /agents/ segment is irrelevant for nested entries", () => {
    const dir = "/srv/agents/team/proj"
    const item = "/srv/agents/team/proj/agents/team/build.md"
    const relative = posix.relative(dir, item)
    expect(relative).toBe("agents/team/build.md")
    expect(configEntryNameFromPath(relative, AGENT_PREFIXES)).toBe("team/build")
  })
})
