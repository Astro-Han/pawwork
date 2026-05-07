import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { buildSessionMenuActions } from "./session-menu-actions"

const session = { id: "ses_123", title: "Bug hunt", directory: "/repo" } as Session

const labels = {
  pin: "Pin",
  unpin: "Unpin",
  rename: "Rename",
  export: "Export",
  delete: "Delete",
}

describe("buildSessionMenuActions", () => {
  test("builds the shared visible action order for session menus", () => {
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
})
