import { describe, expect, test } from "bun:test"
import { toggleDesktopTerminal } from "./terminal-shell-tab"

describe("toggleDesktopTerminal", () => {
  test("closes the terminal shell tab through the side-panel tab API", () => {
    const calls: string[] = []

    toggleDesktopTerminal(
      {
        sidePanel: {
          opened: () => true,
          tab: () => "terminal",
          toggleTab: (tab) => calls.push(`toggleTab:${tab}`),
        },
      },
      {
        open: () => calls.push("terminal.open"),
        close: () => calls.push("terminal.close"),
      },
    )

    expect(calls).toEqual(["toggleTab:terminal", "terminal.close"])
  })

  test("opens the terminal shell tab through the side-panel tab API", () => {
    const calls: string[] = []

    toggleDesktopTerminal(
      {
        sidePanel: {
          opened: () => true,
          tab: () => "status",
          toggleTab: (tab) => calls.push(`toggleTab:${tab}`),
        },
      },
      {
        open: () => calls.push("terminal.open"),
        close: () => calls.push("terminal.close"),
      },
    )

    expect(calls).toEqual(["toggleTab:terminal", "terminal.open"])
  })
})
