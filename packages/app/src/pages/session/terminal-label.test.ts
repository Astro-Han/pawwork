import { describe, expect, test } from "bun:test"

import { computeTerminalLabels, terminalTabLabel } from "./terminal-label"
import { terminalTabID } from "@/context/terminal-types"

const t = (key: string, vars?: Record<string, string | number | boolean>) => {
  if (key === "terminal.title.numbered") return `Terminal ${vars?.number}`
  if (key === "terminal.title") return "Terminal"
  return key
}

describe("terminalTabLabel", () => {
  test("returns custom title unchanged", () => {
    const label = terminalTabLabel({ title: "server", titleNumber: 3, t })
    expect(label).toBe("server")
  })

  test("normalizes default numbered title", () => {
    const label = terminalTabLabel({ title: "Terminal 2", titleNumber: 2, t })
    expect(label).toBe("Terminal 2")
  })

  test("falls back to generic title", () => {
    const label = terminalTabLabel({ title: "", titleNumber: 0, t })
    expect(label).toBe("Terminal")
  })
})

describe("computeTerminalLabels", () => {
  test("uses cwd basename when no custom title", () => {
    const labels = computeTerminalLabels(
      [{ tabID: terminalTabID("a"), title: "", titleNumber: 1, cwd: "/Users/yuhan/pawwork" }],
      { t },
    )
    expect(labels.get(terminalTabID("a"))).toBe("pawwork")
  })

  test("appends index for duplicate cwd basenames", () => {
    const labels = computeTerminalLabels(
      [
        { tabID: terminalTabID("a"), title: "", titleNumber: 1, cwd: "/repo/pawwork" },
        { tabID: terminalTabID("b"), title: "", titleNumber: 2, cwd: "/repo/pawwork" },
        { tabID: terminalTabID("c"), title: "", titleNumber: 3, cwd: "/repo/pawwork" },
      ],
      { t },
    )
    expect(labels.get(terminalTabID("a"))).toBe("pawwork")
    expect(labels.get(terminalTabID("b"))).toBe("pawwork 2")
    expect(labels.get(terminalTabID("c"))).toBe("pawwork 3")
  })

  test("different cwds keep their own basenames", () => {
    const labels = computeTerminalLabels(
      [
        { tabID: terminalTabID("a"), title: "", titleNumber: 1, cwd: "/repo/pawwork" },
        { tabID: terminalTabID("b"), title: "", titleNumber: 2, cwd: "/repo/content-strategy" },
      ],
      { t },
    )
    expect(labels.get(terminalTabID("a"))).toBe("pawwork")
    expect(labels.get(terminalTabID("b"))).toBe("content-strategy")
  })

  test("custom title wins over cwd basename", () => {
    const labels = computeTerminalLabels(
      [{ tabID: terminalTabID("a"), title: "build watch", titleNumber: 1, cwd: "/repo/pawwork" }],
      { t },
    )
    expect(labels.get(terminalTabID("a"))).toBe("build watch")
  })

  test("a default-pattern stored title is overridden by cwd basename", () => {
    // backend may persist title as "Terminal 1" — we want cwd basename when available
    const labels = computeTerminalLabels(
      [{ tabID: terminalTabID("a"), title: "Terminal 1", titleNumber: 1, cwd: "/repo/pawwork" }],
      { t },
    )
    expect(labels.get(terminalTabID("a"))).toBe("pawwork")
  })

  test("falls back to numbered label when no cwd basename available", () => {
    const labels = computeTerminalLabels(
      [{ tabID: terminalTabID("a"), title: "", titleNumber: 5, cwd: undefined }],
      { t },
    )
    expect(labels.get(terminalTabID("a"))).toBe("Terminal 5")
  })

  test("falls back to generic label when no cwd and no number", () => {
    const labels = computeTerminalLabels(
      [{ tabID: terminalTabID("a"), title: "", titleNumber: 0, cwd: undefined }],
      { t },
    )
    expect(labels.get(terminalTabID("a"))).toBe("Terminal")
  })

  test("trailing slashes in cwd don't break basename", () => {
    const labels = computeTerminalLabels(
      [{ tabID: terminalTabID("a"), title: "", titleNumber: 1, cwd: "/repo/pawwork/" }],
      { t },
    )
    expect(labels.get(terminalTabID("a"))).toBe("pawwork")
  })

  test("root path falls back to numbered", () => {
    const labels = computeTerminalLabels(
      [{ tabID: terminalTabID("a"), title: "", titleNumber: 2, cwd: "/" }],
      { t },
    )
    expect(labels.get(terminalTabID("a"))).toBe("Terminal 2")
  })

  test("windows backslash path basename", () => {
    const labels = computeTerminalLabels(
      [{ tabID: terminalTabID("a"), title: "", titleNumber: 1, cwd: "C:\\Users\\yuhan\\pawwork" }],
      { t },
    )
    expect(labels.get(terminalTabID("a"))).toBe("pawwork")
  })

  test("windows path with trailing backslash", () => {
    const labels = computeTerminalLabels(
      [{ tabID: terminalTabID("a"), title: "", titleNumber: 1, cwd: "C:\\repo\\pawwork\\" }],
      { t },
    )
    expect(labels.get(terminalTabID("a"))).toBe("pawwork")
  })

  test("windows drive root falls back to numbered", () => {
    const labels = computeTerminalLabels(
      [{ tabID: terminalTabID("a"), title: "", titleNumber: 4, cwd: "C:\\" }],
      { t },
    )
    expect(labels.get(terminalTabID("a"))).toBe("Terminal 4")
  })

  test("windows UNC root falls back to numbered", () => {
    const labels = computeTerminalLabels(
      [{ tabID: terminalTabID("a"), title: "", titleNumber: 5, cwd: "\\\\server" }],
      { t },
    )
    expect(labels.get(terminalTabID("a"))).toBe("Terminal 5")
  })

  test("windows UNC share root keeps the share name as label", () => {
    // `\\server\share` is a complete share; the share name is meaningful, so
    // it stays the label (unlike the bare `\\server` prefix, which is numbered).
    const labels = computeTerminalLabels(
      [{ tabID: terminalTabID("a"), title: "", titleNumber: 1, cwd: "\\\\server\\share" }],
      { t },
    )
    expect(labels.get(terminalTabID("a"))).toBe("share")
  })

  test("windows UNC share path returns leaf segment", () => {
    const labels = computeTerminalLabels(
      [{ tabID: terminalTabID("a"), title: "", titleNumber: 1, cwd: "\\\\server\\share\\repo" }],
      { t },
    )
    expect(labels.get(terminalTabID("a"))).toBe("repo")
  })

  test("mixed-separator path uses the rightmost separator", () => {
    const labels = computeTerminalLabels(
      [{ tabID: terminalTabID("a"), title: "", titleNumber: 1, cwd: "C:/Users\\yuhan/pawwork" }],
      { t },
    )
    expect(labels.get(terminalTabID("a"))).toBe("pawwork")
  })

  test("rename + sibling combo: custom title sits alongside basename dedup", () => {
    const labels = computeTerminalLabels(
      [
        { tabID: terminalTabID("a"), title: "build", titleNumber: 1, cwd: "/repo/pawwork" },
        { tabID: terminalTabID("b"), title: "", titleNumber: 2, cwd: "/repo/pawwork" },
        { tabID: terminalTabID("c"), title: "", titleNumber: 3, cwd: "/repo/pawwork" },
      ],
      { t },
    )
    expect(labels.get(terminalTabID("a"))).toBe("build")
    // renamed tab doesn't consume a basename slot; b is the first default → "pawwork", c → "pawwork 2"
    expect(labels.get(terminalTabID("b"))).toBe("pawwork")
    expect(labels.get(terminalTabID("c"))).toBe("pawwork 2")
  })
})
