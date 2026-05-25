import { describe, expect, test } from "bun:test"
import { createCloseShellTabRouter, toggleDesktopTerminal } from "./terminal-shell-tab"
import { terminalTabID, type TerminalTabID } from "@/context/terminal-types"

describe("toggleDesktopTerminal", () => {
  test("closes the panel when a terminal tab is currently active", () => {
    const calls: string[] = []
    const tabId = terminalTabID("t1")

    toggleDesktopTerminal(
      {
        sidePanel: {
          opened: () => true,
          tab: () => "terminal:t1",
          openTab: (tab) => calls.push(`openTab:${tab}`),
          close: () => calls.push("sidePanel.close"),
        },
      },
      {
        active: () => "t1",
        all: () => [{ tabID: tabId }],
        new: () => calls.push("terminal.new"),
      },
    )

    expect(calls).toEqual(["sidePanel.close"])
  })

  test("switches to the active terminal tab when not currently on one", () => {
    const calls: string[] = []
    const tabId = terminalTabID("t1")

    toggleDesktopTerminal(
      {
        sidePanel: {
          opened: () => true,
          tab: () => "status",
          openTab: (tab) => calls.push(`openTab:${tab}`),
          close: () => calls.push("sidePanel.close"),
        },
      },
      {
        active: () => "t1",
        all: () => [{ tabID: tabId }],
        new: () => calls.push("terminal.new"),
      },
    )

    expect(calls).toEqual(["openTab:terminal:t1"])
  })

  test("creates a new terminal when none exist yet", () => {
    const calls: string[] = []
    let activeId: string | undefined = undefined

    toggleDesktopTerminal(
      {
        sidePanel: {
          opened: () => false,
          tab: () => "status",
          openTab: (tab) => calls.push(`openTab:${tab}`),
          close: () => calls.push("sidePanel.close"),
        },
      },
      {
        active: () => activeId,
        all: () => (activeId ? [{ tabID: terminalTabID(activeId) }] : []),
        new: () => {
          calls.push("terminal.new")
          activeId = "new1"
        },
      },
    )

    expect(calls).toEqual(["terminal.new", "openTab:terminal:new1"])
  })

  test("falls back to the first terminal when nothing is marked active", () => {
    const calls: string[] = []
    const tabId = terminalTabID("first")

    toggleDesktopTerminal(
      {
        sidePanel: {
          opened: () => false,
          tab: () => "status",
          openTab: (tab) => calls.push(`openTab:${tab}`),
          close: () => calls.push("sidePanel.close"),
        },
      },
      {
        active: () => undefined,
        all: () => [{ tabID: tabId }],
        new: () => calls.push("terminal.new"),
      },
    )

    expect(calls).toEqual(["openTab:terminal:first"])
  })
})

describe("createCloseShellTabRouter", () => {
  const buildDeps = (opts: {
    activeTab: string
    terminals: string[]
  }) => {
    const calls: string[] = []
    const router = createCloseShellTabRouter({
      view: () => ({
        sidePanel: {
          tab: () => opts.activeTab as never,
          openTab: (tab) => calls.push(`openTab:${tab}`),
          closeTab: (tab) => calls.push(`closeTab:${tab}`),
        },
      }),
      terminal: () => ({
        all: () => opts.terminals.map((id) => ({ tabID: terminalTabID(id) })),
        close: (id) => calls.push(`terminal.close:${id}`),
      }),
    })
    return { router, calls }
  }

  test("static tab close goes straight to sidePanel.closeTab", () => {
    const { router, calls } = buildDeps({ activeTab: "files", terminals: [] })
    router("files")
    expect(calls).toEqual(["closeTab:files"])
  })

  test("terminal tab close calls terminal.close (P1: keyboard close used to skip this)", () => {
    const { router, calls } = buildDeps({ activeTab: "status", terminals: ["a", "b"] })
    router("terminal:a" as never)
    // Not the active tab → just close the terminal, don't touch sidePanelTab.
    expect(calls).toEqual(["terminal.close:a"])
  })

  test("closing the active terminal falls focus to the previous terminal", () => {
    const { router, calls } = buildDeps({ activeTab: "terminal:b", terminals: ["a", "b", "c"] })
    router("terminal:b" as never)
    expect(calls).toEqual(["terminal.close:b", "openTab:terminal:a"])
  })

  test("closing the first terminal (no previous sibling) hands focus back via closeTab → status", () => {
    const { router, calls } = buildDeps({ activeTab: "terminal:a", terminals: ["a", "b"] })
    router("terminal:a" as never)
    expect(calls).toEqual(["terminal.close:a", "closeTab:terminal:a"])
  })

  test("closing the only terminal leaves the router to defer to closeTab (status)", () => {
    const { router, calls } = buildDeps({ activeTab: "terminal:only", terminals: ["only"] })
    router("terminal:only" as never)
    expect(calls).toEqual(["terminal.close:only", "closeTab:terminal:only"])
  })

  test("ignores unknown terminal id gracefully (still calls close to be safe)", () => {
    const { router, calls } = buildDeps({ activeTab: "status", terminals: ["a"] })
    router("terminal:ghost" as never)
    // We still issue terminal.close — terminal context can no-op on unknown ids.
    // No openTab/closeTab side effects since ghost isn't the active tab.
    expect(calls).toEqual(["terminal.close:ghost"])
  })
})

// Type smoke: TerminalTabID is the branded shape we expect.
const _typecheck: TerminalTabID = terminalTabID("noop")
void _typecheck
