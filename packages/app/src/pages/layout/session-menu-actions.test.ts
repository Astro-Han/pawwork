import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { buildSessionMenuActions } from "./session-menu-actions"

const session = { id: "ses_123", title: "Bug hunt", directory: "/repo" } as Session

const labels = {
  pin: "Pin",
  unpin: "Unpin",
  moveUp: "Move up",
  moveDown: "Move down",
  rename: "Rename",
  export: "Export",
  delete: "Delete",
}

describe("buildSessionMenuActions", () => {
  test("builds the shared visible action order for unpinned session menus", () => {
    const actions = buildSessionMenuActions({
      session,
      pinned: false,
      exportAvailable: true,
      labels,
      onTogglePinnedSession: () => undefined,
      onRenameSession: () => undefined,
      onExportSession: () => undefined,
      onDeleteSession: () => undefined,
    })

    expect(actions.map((action) => action.id)).toEqual(["pin", "rename", "export", "delete"])
    expect(actions.map((action) => action.label)).toEqual(["Pin", "Rename", "Export", "Delete"])
    expect(actions.map((action) => action.icon)).toEqual(["pin", "pencil-line", "download", "trash"])
    expect(actions.find((action) => action.id === "delete")?.separatorBefore).toBe(true)
  })

  test("uses unpin label for pinned sessions and omits export when unavailable", () => {
    const actions = buildSessionMenuActions({
      session,
      pinned: true,
      exportAvailable: false,
      labels,
      onTogglePinnedSession: () => undefined,
      onRenameSession: () => undefined,
      onExportSession: () => undefined,
      onDeleteSession: () => undefined,
    })

    expect(actions.map((action) => [action.id, action.label])).toEqual([
      ["pin", "Unpin"],
      ["rename", "Rename"],
      ["delete", "Delete"],
    ])
    expect(actions.map((action) => action.icon)).toEqual(["pin", "pencil-line", "trash"])
  })

  test("binds each action to the target session", () => {
    const calls: string[] = []
    const actions = buildSessionMenuActions({
      session,
      pinned: false,
      exportAvailable: true,
      labels,
      onTogglePinnedSession: (sessionID) => calls.push(`pin:${sessionID}`),
      onRenameSession: (item) => {
        calls.push(`rename:${item.id}`)
      },
      onExportSession: (item) => {
        calls.push(`export:${item.id}`)
      },
      onDeleteSession: (item) => calls.push(`delete:${item.id}`),
    })

    for (const action of actions) void action.run()

    expect(calls).toEqual(["pin:ses_123", "rename:ses_123", "export:ses_123", "delete:ses_123"])
  })

  test("offers move-up and move-down only when pinned + index allows", () => {
    const onMove = () => undefined
    const baseInput = {
      session,
      pinned: true,
      exportAvailable: false,
      labels,
      onTogglePinnedSession: () => undefined,
      onMovePinnedSession: onMove,
      onRenameSession: () => undefined,
      onExportSession: () => undefined,
      onDeleteSession: () => undefined,
    } as const

    // Middle of a 3-pinned list: both moves available
    expect(
      buildSessionMenuActions({ ...baseInput, pinnedIndex: 1, pinnedCount: 3 }).map((action) => action.id),
    ).toEqual(["pin", "move-up", "move-down", "rename", "delete"])

    // Top of pinned list: only move-down
    expect(
      buildSessionMenuActions({ ...baseInput, pinnedIndex: 0, pinnedCount: 3 }).map((action) => action.id),
    ).toEqual(["pin", "move-down", "rename", "delete"])

    // Bottom of pinned list: only move-up
    expect(
      buildSessionMenuActions({ ...baseInput, pinnedIndex: 2, pinnedCount: 3 }).map((action) => action.id),
    ).toEqual(["pin", "move-up", "rename", "delete"])

    // Single pinned row: neither move offered
    expect(
      buildSessionMenuActions({ ...baseInput, pinnedIndex: 0, pinnedCount: 1 }).map((action) => action.id),
    ).toEqual(["pin", "rename", "delete"])

    // Pinned but no onMovePinnedSession callback: neither move offered
    expect(
      buildSessionMenuActions({
        ...baseInput,
        onMovePinnedSession: undefined,
        pinnedIndex: 1,
        pinnedCount: 3,
      }).map((action) => action.id),
    ).toEqual(["pin", "rename", "delete"])

    // Unpinned: neither move offered, even with index supplied
    expect(
      buildSessionMenuActions({
        ...baseInput,
        pinned: false,
        pinnedIndex: 1,
        pinnedCount: 3,
      }).map((action) => action.id),
    ).toEqual(["pin", "rename", "delete"])
  })

  test("move-up and move-down dispatch the correct direction", () => {
    const calls: Array<{ sessionID: string; direction: "up" | "down" }> = []
    const actions = buildSessionMenuActions({
      session,
      pinned: true,
      pinnedIndex: 1,
      pinnedCount: 3,
      exportAvailable: false,
      labels,
      onTogglePinnedSession: () => undefined,
      onMovePinnedSession: (input) => calls.push(input),
      onRenameSession: () => undefined,
      onExportSession: () => undefined,
      onDeleteSession: () => undefined,
    })

    void actions.find((a) => a.id === "move-up")?.run()
    void actions.find((a) => a.id === "move-down")?.run()

    expect(calls).toEqual([
      { sessionID: "ses_123", direction: "up" },
      { sessionID: "ses_123", direction: "down" },
    ])
  })
})
