import { describe, expect, test } from "bun:test"
import {
  assertNoUnsafeTerminalStorageFields,
  migratePersistedTerminalState,
  sanitizePersistedTerminalState,
  unsafeTerminalStorageFieldNames,
} from "./terminal-storage"

describe("migratePersistedTerminalState", () => {
  test("migrates legacy PTY ids into durable tab ids and remaps active", () => {
    const migrated = migratePersistedTerminalState({
      active: "pty_old",
      all: [
        {
          id: "pty_old",
          title: "Terminal 2",
          titleNumber: 2,
          rows: 24,
          cols: 80,
          buffer: "old output",
          cursor: 12,
          scrollY: 8,
          ptyID: "pty_runtime",
        },
      ],
    })

    expect(migrated.version).toBe(2)
    expect(migrated.tabs).toHaveLength(1)
    expect(migrated.tabs[0]?.tabID).toStartWith("tab_")
    expect(migrated.tabs[0]?.tabID).not.toBe("pty_old")
    expect(migrated.activeTabID).toBe(migrated.tabs[0]?.tabID)
    expect(JSON.stringify(migrated)).not.toContain("pty_old")
    expect(JSON.stringify(migrated)).not.toContain("pty_runtime")
    expect(migrated.tabs[0]?.snapshot).toEqual({
      size: { rows: 24, cols: 80 },
      buffer: "old output",
      cursor: 12,
      scrollY: 8,
    })
  })

  test("migration is idempotent for v2 state", () => {
    const first = migratePersistedTerminalState({
      active: "pty_old",
      all: [{ id: "pty_old", title: "Terminal 1", titleNumber: 1, buffer: "output", cursor: 6 }],
    })
    const second = migratePersistedTerminalState(first)

    expect(second).toEqual(first)
  })

  test("drops invalid legacy terminals and keeps stable order", () => {
    const migrated = migratePersistedTerminalState({
      active: "pty_second",
      all: [
        null,
        { title: "missing id" },
        { id: "pty_first", title: "Terminal 1", titleNumber: 1 },
        { id: "pty_first", title: "duplicate", titleNumber: 9 },
        { id: "pty_second", title: "logs", titleNumber: 4, rows: 30, cols: 100 },
      ],
    })

    expect(migrated.tabs.map((tab) => tab.title)).toEqual(["Terminal 1", "logs"])
    expect(migrated.tabs.map((tab) => tab.order)).toEqual([0, 1])
    expect(migrated.activeTabID).toBe(migrated.tabs[1]?.tabID)
    expect(new Set(migrated.tabs.map((tab) => tab.tabID)).size).toBe(2)
  })
})

describe("sanitizePersistedTerminalState", () => {
  test("drops runtime fields before persistence", () => {
    const state = {
      version: 2,
      activeTabID: "tab_one",
      tabs: [
        {
          tabID: "tab_one",
          title: "Terminal 1",
          titleNumber: 1,
          order: 0,
          ptyID: "pty_runtime",
          ptyId: "pty_runtime",
          runtimePtyID: "pty_runtime",
          runtimePtyId: "pty_runtime",
          runtimePTYID: "pty_runtime",
          snapshot: {
            size: { rows: 24, cols: 80 },
            buffer: "visible",
            cursor: 7,
            scrollY: 1,
            ptyID: "pty_nested",
          },
        },
      ],
    }

    const sanitized = sanitizePersistedTerminalState(state)
    const serialized = JSON.stringify(sanitized)

    for (const field of unsafeTerminalStorageFieldNames) {
      expect(serialized).not.toContain(field)
    }
    expect(serialized).not.toContain("pty_runtime")
    expect(serialized).not.toContain("pty_nested")
    expect(sanitized.tabs[0]?.snapshot).toEqual({
      size: { rows: 24, cols: 80 },
      buffer: "visible",
      cursor: 7,
      scrollY: 1,
    })
  })

  test("fail-loud assertion reports runtime fields in test and development paths", () => {
    expect(() =>
      assertNoUnsafeTerminalStorageFields({
        version: 2,
        activeTabID: "tab_one",
        tabs: [{ tabID: "tab_one", title: "Terminal 1", titleNumber: 1, order: 0, ptyID: "pty_runtime" }],
      }),
    ).toThrow("Unsafe terminal storage field: tabs.0.ptyID")
  })
})
