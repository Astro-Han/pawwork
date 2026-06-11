import { describe, expect, test } from "bun:test"
import { createMemo, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { base64Encode } from "@opencode-ai/util/encode"
import {
  createOpenReviewFile,
  createOpenSessionFileTab,
  createSessionTabs,
  focusTerminalById,
  getTabReorderIndex,
  planShellTabReorder,
  sizingStopEvents,
  shouldFocusTerminalOnKeyDown,
  subscribeAutomationAttached,
} from "./helpers"

describe("createOpenReviewFile", () => {
  test("opens and loads selected review file", () => {
    const calls: string[] = []
    const openReviewFile = createOpenReviewFile({
      showAllFiles: () => calls.push("show"),
      tabForPath: (path) => {
        calls.push(`tab:${path}`)
        return `file://${path}`
      },
      openTab: (tab) => calls.push(`open:${tab}`),
      setActive: (tab) => calls.push(`active:${tab}`),
      loadFile: (path) => calls.push(`load:${path}`),
    })

    openReviewFile("src/a.ts")

    expect(calls).toEqual(["show", "load:src/a.ts", "tab:src/a.ts", "open:file://src/a.ts", "active:file://src/a.ts"])
  })
})

describe("createOpenSessionFileTab", () => {
  test("activates the opened file tab", () => {
    const calls: string[] = []
    const openTab = createOpenSessionFileTab({
      normalizeTab: (value) => {
        calls.push(`normalize:${value}`)
        return `file://${value}`
      },
      openTab: (tab) => calls.push(`open:${tab}`),
      pathFromTab: (tab) => {
        calls.push(`path:${tab}`)
        return tab.slice("file://".length)
      },
      loadFile: (path) => calls.push(`load:${path}`),
      openReviewPanel: () => calls.push("review"),
      setActive: (tab) => calls.push(`active:${tab}`),
    })

    openTab("src/a.ts")

    expect(calls).toEqual([
      "normalize:src/a.ts",
      "open:file://src/a.ts",
      "path:file://src/a.ts",
      "load:src/a.ts",
      "review",
      "active:file://src/a.ts",
    ])
  })
})

describe("focusTerminalById", () => {
  test("focuses textarea when present", () => {
    document.body.innerHTML = `<div id="terminal-wrapper-one"><div data-component="terminal"><textarea></textarea></div></div>`

    const focused = focusTerminalById("one")

    expect(focused).toBe(true)
    expect(document.activeElement?.tagName).toBe("TEXTAREA")
  })

  test("falls back to terminal element focus", () => {
    document.body.innerHTML = `<div id="terminal-wrapper-two"><div data-component="terminal" tabindex="0"></div></div>`
    const terminal = document.querySelector('[data-component="terminal"]') as HTMLElement
    let pointerDown = false
    terminal.addEventListener("pointerdown", () => {
      pointerDown = true
    })

    const focused = focusTerminalById("two")

    expect(focused).toBe(true)
    expect(document.activeElement).toBe(terminal)
    expect(pointerDown).toBe(true)
  })
})

describe("shouldFocusTerminalOnKeyDown", () => {
  test("skips pure modifier keys", () => {
    expect(shouldFocusTerminalOnKeyDown(new KeyboardEvent("keydown", { key: "Meta", metaKey: true }))).toBe(false)
    expect(shouldFocusTerminalOnKeyDown(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }))).toBe(false)
    expect(shouldFocusTerminalOnKeyDown(new KeyboardEvent("keydown", { key: "Alt", altKey: true }))).toBe(false)
    expect(shouldFocusTerminalOnKeyDown(new KeyboardEvent("keydown", { key: "Shift", shiftKey: true }))).toBe(false)
  })

  test("skips shortcut key combos", () => {
    expect(shouldFocusTerminalOnKeyDown(new KeyboardEvent("keydown", { key: "c", metaKey: true }))).toBe(false)
    expect(shouldFocusTerminalOnKeyDown(new KeyboardEvent("keydown", { key: "c", ctrlKey: true }))).toBe(false)
    expect(shouldFocusTerminalOnKeyDown(new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true }))).toBe(false)
  })

  test("keeps plain typing focused on terminal", () => {
    expect(shouldFocusTerminalOnKeyDown(new KeyboardEvent("keydown", { key: "a" }))).toBe(true)
    expect(shouldFocusTerminalOnKeyDown(new KeyboardEvent("keydown", { key: "A", shiftKey: true }))).toBe(true)
  })
})

describe("getTabReorderIndex", () => {
  test("returns target index for valid drag reorder", () => {
    expect(getTabReorderIndex(["a", "b", "c"], "a", "c")).toBe(2)
  })

  test("returns undefined for unknown droppable id", () => {
    expect(getTabReorderIndex(["a", "b", "c"], "a", "missing")).toBeUndefined()
  })
})

describe("planShellTabReorder", () => {
  test("static to static returns a static move", () => {
    const plan = planShellTabReorder({
      draggableId: "review",
      droppableId: "context",
      openStatic: ["status", "review", "context"],
      terminalIds: [],
    })
    expect(plan).toEqual({ kind: "static", target: "review", to: 2 })
  })

  test("terminal to terminal returns a terminal move with terminal-segment index", () => {
    const plan = planShellTabReorder({
      draggableId: "terminal:a",
      droppableId: "terminal:c",
      openStatic: ["status", "review"],
      terminalIds: ["a", "b", "c"],
    })
    expect(plan).toEqual({ kind: "terminal", target: "a", to: 2 })
  })

  test("cross-segment drag (static <-> terminal) is a no-op", () => {
    expect(
      planShellTabReorder({
        draggableId: "review",
        droppableId: "terminal:a",
        openStatic: ["status", "review", "review"],
        terminalIds: ["a"],
      }),
    ).toBeNull()
    expect(
      planShellTabReorder({
        draggableId: "terminal:a",
        droppableId: "review",
        openStatic: ["status", "review", "review"],
        terminalIds: ["a"],
      }),
    ).toBeNull()
  })

  test("dragging onto self is a no-op", () => {
    expect(
      planShellTabReorder({
        draggableId: "review",
        droppableId: "review",
        openStatic: ["status", "review", "review"],
        terminalIds: [],
      }),
    ).toBeNull()
  })

  test("dragging an unknown id is a no-op", () => {
    expect(
      planShellTabReorder({
        draggableId: "ghost",
        droppableId: "review",
        openStatic: ["status", "review"],
        terminalIds: [],
      }),
    ).toBeNull()
    expect(
      planShellTabReorder({
        draggableId: "terminal:zzz",
        droppableId: "terminal:a",
        openStatic: ["status"],
        terminalIds: ["a", "b"],
      }),
    ).toBeNull()
  })

  test("rejects dragging onto status (pinned)", () => {
    expect(
      planShellTabReorder({
        draggableId: "review",
        droppableId: "status",
        openStatic: ["status", "review"],
        terminalIds: [],
      }),
    ).toBeNull()
  })

  test("rejects dragging status itself", () => {
    expect(
      planShellTabReorder({
        draggableId: "status",
        droppableId: "review",
        openStatic: ["status", "review"],
        terminalIds: [],
      }),
    ).toBeNull()
  })
})

describe("createSizing", () => {
  test("listens for mouse and touch endings as resize fallbacks", () => {
    expect(sizingStopEvents).toEqual(["pointerup", "pointercancel", "mouseup", "touchend", "touchcancel", "blur"])
  })
})

describe("createSessionTabs", () => {
  test("normalizes the effective file tab", () => {
    createRoot((dispose) => {
      const [state] = createStore({
        active: undefined as string | undefined,
        all: ["file://src/a.ts", "context"],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: (tab) => (tab.startsWith("file://") ? tab.slice("file://".length) : undefined),
        normalizeTab: (tab) => (tab.startsWith("file://") ? `norm:${tab.slice("file://".length)}` : tab),
      })

      expect(result.activeTab()).toBe("norm:src/a.ts")
      expect(result.activeFileTab()).toBe("norm:src/a.ts")
      expect(result.closableTab()).toBe("norm:src/a.ts")
      dispose()
    })
  })

  test("does not expose a stale active file tab as closable", () => {
    createRoot((dispose) => {
      const [state] = createStore({
        active: "file://src/missing.ts" as string | undefined,
        all: ["file://src/a.ts"],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: (tab) => (tab.startsWith("file://") ? tab.slice("file://".length) : undefined),
        normalizeTab: (tab) => (tab.startsWith("file://") ? `norm:${tab.slice("file://".length)}` : tab),
      })

      expect(result.activeTab()).toBe("norm:src/a.ts")
      expect(result.closableTab()).toBe("norm:src/a.ts")
      dispose()
    })
  })

  test("ignores legacy context entries and falls back to review when no file tab is active", () => {
    createRoot((dispose) => {
      const [state] = createStore({
        active: undefined as string | undefined,
        all: ["context"],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: () => undefined,
        normalizeTab: (tab) => tab,
        review: () => true,
        hasReview: () => true,
      })

      expect(result.activeTab()).toBe("review")
      expect(result.closableTab()).toBeUndefined()
      dispose()
    })

    createRoot((dispose) => {
      const [state] = createStore({
        active: undefined as string | undefined,
        all: [],
      })
      const tabs = createMemo(() => ({ active: () => state.active, all: () => state.all }))
      const result = createSessionTabs({
        tabs,
        pathFromTab: () => undefined,
        normalizeTab: (tab) => tab,
        review: () => true,
        hasReview: () => true,
      })

      expect(result.activeTab()).toBe("review")
      expect(result.activeFileTab()).toBeUndefined()
      expect(result.closableTab()).toBeUndefined()
      dispose()
    })
  })
})

describe("subscribeAutomationAttached", () => {
  test("keys the layout write by the driven session's own directory, then unsubscribes cleanly", async () => {
    const opened: string[] = []
    let fire: ((payload: { sessionID: string }) => void) | undefined
    let unsubscribed = false
    const unsubscribe = subscribeAutomationAttached(
      {
        onAutomationAttached: (cb) => {
          fire = cb
          return () => {
            unsubscribed = true
          }
        },
      },
      // The watching window may sit on another project: the key must come from
      // the session's resolved directory, never the viewer's route.
      async (sessionID) => (sessionID === "ses_a" ? "/project/a" : "/project/b"),
      (sessionKey) => opened.push(sessionKey),
    )
    fire?.({ sessionID: "ses_a" })
    fire?.({ sessionID: "ses_b" })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(opened).toEqual([`${base64Encode("/project/a")}/ses_a`, `${base64Encode("/project/b")}/ses_b`])
    unsubscribe()
    expect(unsubscribed).toBe(true)
  })

  test("opens nothing when the session does not resolve (deleted mid-flight or lookup failure)", async () => {
    let fire: ((payload: { sessionID: string }) => void) | undefined
    subscribeAutomationAttached(
      { onAutomationAttached: (cb) => ((fire = cb), () => {}) },
      async (sessionID) => (sessionID === "ses_gone" ? undefined : Promise.reject(new Error("boom"))),
      () => {
        throw new Error("must not open")
      },
    )
    fire?.({ sessionID: "ses_gone" })
    fire?.({ sessionID: "ses_err" })
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  test("no-ops on platforms without the embedded browser", () => {
    const unsubscribe = subscribeAutomationAttached(
      undefined,
      async () => "/project/a",
      () => {
        throw new Error("must not open")
      },
    )
    expect(unsubscribe()).toBeUndefined()
  })
})
