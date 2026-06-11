import { describe, expect, test } from "bun:test"
import type { BrowserBridge, BrowserState } from "@/context/platform"
import { browserTabCloseAction, createBrowserTabClose } from "./close-page"
import { createCloseShellTabRouter } from "@/pages/session/terminal-shell-tab"

// Closing the browser tab destroys the page (WYSIWYG — the chip's × says
// "Close"). These tests pin the decision rule and the flow around it: confirm
// only when a real page would be yanked from a running agent, and both close
// paths (chip × and mod+w) route through the same flow.

function makeFlow(opts: { hasPage: boolean | null; running: boolean; bridge?: boolean }) {
  const calls: string[] = []
  const bridge =
    opts.bridge === false
      ? undefined
      : ({
          closePage: async () => {
            calls.push("closePage")
          },
          getState: async () =>
            opts.hasPage === null ? null : ({ hasPage: opts.hasPage } as BrowserState),
        } as unknown as BrowserBridge)
  const flow = createBrowserTabClose({
    bridge: () => bridge,
    target: () => "ses_a",
    running: () => opts.running,
    closeTab: () => {
      calls.push("closeTab")
    },
    confirm: (proceed) => {
      calls.push("confirm")
      proceed()
    },
  })
  return { flow, calls }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("browserTabCloseAction", () => {
  test("confirms only when a live page would be yanked from a running agent", () => {
    expect(browserTabCloseAction({ hasPage: true, running: true })).toBe("confirm")
    expect(browserTabCloseAction({ hasPage: true, running: false })).toBe("close")
    expect(browserTabCloseAction({ hasPage: false, running: true })).toBe("close")
    expect(browserTabCloseAction({ hasPage: false, running: false })).toBe("close")
  })
})

describe("createBrowserTabClose", () => {
  test("destroys the page and closes the tab when the agent is idle", async () => {
    const { flow, calls } = makeFlow({ hasPage: true, running: false })
    flow()
    await settle()
    expect(calls).toEqual(["closePage", "closeTab"])
  })

  test("routes through confirm when an agent task is running against a live page", async () => {
    const { flow, calls } = makeFlow({ hasPage: true, running: true })
    flow()
    await settle()
    expect(calls).toEqual(["confirm", "closePage", "closeTab"])
  })

  test("a pageless view closes silently even mid-run — there is nothing to yank", async () => {
    const { flow, calls } = makeFlow({ hasPage: null, running: true })
    flow()
    await settle()
    expect(calls).toEqual(["closePage", "closeTab"])
  })

  test("without a bridge (web) it only closes the tab", async () => {
    const { flow, calls } = makeFlow({ hasPage: true, running: true, bridge: false })
    flow()
    await settle()
    expect(calls).toEqual(["closeTab"])
  })
})

describe("createCloseShellTabRouter browser branch", () => {
  test("routes the browser tab through the close flow instead of a bare layout close", () => {
    const calls: string[] = []
    const router = createCloseShellTabRouter({
      view: () => ({
        sidePanel: {
          tab: () => "status" as const,
          openTab: () => {},
          closeTab: (tab: string) => {
            calls.push(`layoutClose:${tab}`)
          },
        },
      }),
      terminal: () => ({ all: () => [], close: () => {} }),
      closeBrowserTab: () => {
        calls.push("browserFlow")
      },
    })
    router("browser")
    expect(calls).toEqual(["browserFlow"])
    // Other static tabs keep the plain layout close.
    router("context")
    expect(calls).toEqual(["browserFlow", "layoutClose:context"])
  })

  test("falls back to the layout close when no flow is wired (web)", () => {
    const calls: string[] = []
    const router = createCloseShellTabRouter({
      view: () => ({
        sidePanel: {
          tab: () => "status" as const,
          openTab: () => {},
          closeTab: (tab: string) => {
            calls.push(`layoutClose:${tab}`)
          },
        },
      }),
      terminal: () => ({ all: () => [], close: () => {} }),
    })
    router("browser")
    expect(calls).toEqual(["layoutClose:browser"])
  })
})
