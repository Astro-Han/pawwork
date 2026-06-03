import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"
import * as fs from "node:fs/promises"
import * as path from "node:path"

let SessionSidePanel: typeof import("./session-side-panel").SessionSidePanel

const SOURCE_PATH = path.join(__dirname, "session-side-panel.tsx")

// Extract the JSX block bounded by <Tabs.Content value="X" …> … </Tabs.Content>.
// Used by the gating-contract tests below to assert each tab body sits inside
// a Show guard tied to the matching sidePanelTab id.
function findTabContentBlock(source: string, value: string): string {
  const re = new RegExp(`<Tabs\\.Content value="${value}"[\\s\\S]*?</Tabs\\.Content>`)
  const match = source.match(re)
  if (!match) throw new Error(`no <Tabs.Content value="${value}"> block found`)
  return match[0]
}

beforeAll(async () => {
  mock.module("@solid-primitives/media", () => ({
    createMediaQuery: () => () => true,
  }))

  mock.module("@opencode-ai/ui/tabs", () => {
    const Tabs = (_props: any) => null
    Tabs.List = (_props: any) => null
    Tabs.Trigger = (_props: any) => null
    Tabs.Content = (_props: any) => null
    return { Tabs }
  })

  mock.module("@opencode-ai/ui/icon-button", () => ({ IconButton: () => null }))
  mock.module("@opencode-ai/ui/dropdown-menu", () => {
    const DropdownMenu = (_props: any) => null
    DropdownMenu.Trigger = (_props: any) => null
    DropdownMenu.Portal = (_props: any) => null
    DropdownMenu.Content = (_props: any) => null
    DropdownMenu.Item = (_props: any) => null
    DropdownMenu.ItemLabel = (_props: any) => null
    DropdownMenu.Separator = () => null
    return { DropdownMenu }
  })
  mock.module("@opencode-ai/ui/tooltip", () => ({
    Tooltip: (props: { children?: unknown }) => props.children,
    TooltipKeybind: (_props: any) => null,
  }))
  mock.module("@opencode-ai/ui/resize-handle", () => ({ ResizeHandle: () => null }))
  mock.module("@opencode-ai/ui/logo", () => ({ Mark: () => null }))
  mock.module("@thisbeyond/solid-dnd", () => ({
    DragDropProvider: (_props: any) => null,
    DragDropSensors: () => null,
    DragOverlay: (_props: any) => null,
    SortableProvider: (_props: any) => null,
    closestCenter: () => null,
  }))
  mock.module("@/utils/solid-dnd", () => ({
    ConstrainDragYAxis: () => null,
    getDraggableId: () => undefined,
  }))
  mock.module("@opencode-ai/ui/context/dialog", () => ({ useDialog: () => ({ show: () => undefined }) }))
  mock.module("@/components/session-context-usage", () => ({ SessionContextUsage: () => null }))
  mock.module("@/components/session", () => ({
    SessionContextTab: () => null,
    SortableTab: () => null,
    ShellTab: () => null,
    SortableShellTab: () => null,
    FileVisual: () => null,
  }))
  mock.module("@/components/session/session-status-panel", () => ({ SessionStatusPanel: () => null }))
  mock.module("@/context/command", () => ({ useCommand: () => ({ keybind: () => "" }) }))
  mock.module("@/context/file", () => ({
    useFile: () => ({
      ready: () => true,
      tree: { state: () => ({ loaded: true }), children: () => [] },
      tab: (path: string) => `file://${path}`,
      pathFromTab: () => undefined,
      selectedLines: () => null,
      load: async () => undefined,
    }),
  }))
  mock.module("@/context/language", () => ({ useLanguage: () => ({ t: (key: string) => key }) }))
  mock.module("@/context/layout", () => ({
    MIN_RIGHT_PANEL_WIDTH: 280,
    MAX_RIGHT_PANEL_WIDTH: 520,
    useLayout: () => ({
      session: { width: () => 720 },
      rightPanel: { width: () => 360, resize: () => undefined },
    }),
  }))
  mock.module("@/pages/session/file-tabs", () => ({ FileTabContent: () => null }))
  mock.module("@/pages/session/handoff", () => ({ setSessionHandoff: () => undefined }))
  mock.module("@/pages/session/session-layout", () => ({
    sessionRouteLayoutKey: (params: { dir: string | undefined; id: string | undefined }) =>
      params.dir ? `${params.dir}${params.id ? "/" + params.id : ""}` : "",
    useSessionLayout: () => ({
      layoutRouteKey: () => "dir/demo",
      tabs: () => ({
        all: () => [],
        open: () => undefined,
        setActive: () => undefined,
        close: () => undefined,
        move: () => undefined,
      }),
      view: () => ({
        sidePanel: {
          opened: () => true,
          tab: () => "status",
          setTab: () => undefined,
          open: () => undefined,
          toggleTab: () => undefined,
          explorer: { width: () => 240, tab: () => "changes", setTab: () => undefined, resize: () => undefined },
        },
        reviewPanel: { opened: () => true, open: () => undefined },
        terminal: { opened: () => false, open: () => undefined, close: () => undefined },
      }),
    }),
  }))

  SessionSidePanel = (await import("./session-side-panel")).SessionSidePanel
})

afterAll(() => {
  mock.restore()
})

describe("SessionSidePanel", () => {
  test("exports a reusable unified right-panel component", () => {
    expect(typeof SessionSidePanel).toBe("function")
  })

  test("preserves helper exports for later session tests", async () => {
    const helpers = await import("./helpers")
    const fileTabScroll = await import("./file-tab-scroll")
    const sessionComponents = await import("@/components/session")

    expect(typeof helpers.createOpenReviewFile).toBe("function")
    expect(typeof fileTabScroll.nextTabListScrollLeft).toBe("function")
    expect(typeof sessionComponents.ShellTab).toBe("function")
    expect(typeof sessionComponents.SortableShellTab).toBe("function")
  })
})

describe("formatRightPanelWidth", () => {
  test("returns \"0px\" when closed", async () => {
    const { formatRightPanelWidth } = await import("./session-side-panel")
    expect(formatRightPanelWidth(false, 340)).toBe("0px")
    expect(formatRightPanelWidth(false, 520)).toBe("0px")
  })

  test("returns px-suffixed width when open", async () => {
    const { formatRightPanelWidth } = await import("./session-side-panel")
    expect(formatRightPanelWidth(true, 340)).toBe("340px")
    expect(formatRightPanelWidth(true, 520)).toBe("520px")
  })
})

describe("shouldShowReviewFileOpenButton", () => {
  test("hides the standalone file-open button on the main review view", async () => {
    const { shouldShowReviewFileOpenButton } = await import("./session-side-panel")

    expect(shouldShowReviewFileOpenButton("review", false)).toBe(false)
    expect(shouldShowReviewFileOpenButton("context", false)).toBe(true)
    expect(shouldShowReviewFileOpenButton("review", true)).toBe(true)
  })
})

describe("sortableShellTabIds", () => {
  test("keeps the pinned status tab out of sortable ids", async () => {
    const { sortableShellTabIds } = await import("./session-side-panel")

    expect(sortableShellTabIds(["status", "review", "context"])).toEqual(["review", "context"])
  })
})

describe("openReviewShellTab", () => {
  test("opens and activates the review shell tab", async () => {
    const { openReviewShellTab } = await import("./session-side-panel")
    const calls: string[] = []

    openReviewShellTab({ openTab: (tab) => calls.push(tab) })

    expect(calls).toEqual(["review"])
  })
})

describe("makeRightPanelResizeHandler", () => {
  test("calls size.touch() then layout.rightPanel.resize(width) in order", async () => {
    const { makeRightPanelResizeHandler } = await import("./session-side-panel")
    const calls: string[] = []
    const handler = makeRightPanelResizeHandler(
      { touch: () => calls.push("touch") },
      { rightPanel: { resize: (w: number) => calls.push(`resize:${w}`) } },
    )
    handler(350)
    expect(calls).toEqual(["touch", "resize:350"])
  })

  test("passes width through unchanged (clamping is the store's job)", async () => {
    const { makeRightPanelResizeHandler } = await import("./session-side-panel")
    let received = 0
    const handler = makeRightPanelResizeHandler(
      { touch: () => undefined },
      { rightPanel: { resize: (w: number) => (received = w) } },
    )
    handler(280) // below MIN; handler doesn't clamp, store.resize clamps internally
    expect(received).toBe(280)
  })
})

// Inactive-tab gating contract: each right-panel tab body must be wrapped in a
// <Show when={sidePanelTab() === "<id>"}> so its content fully unmounts when the
// user is on another tab. A render test would need to mock SessionSidePanel's
// entire context surface; this source-grep matches the project pattern used in
// `no-mode-picker.test.ts` and catches the most likely regressions: tab-id
// typos, copy-paste mistakes, and any future "let's drop the Show wrap" change.
describe("right-panel inactive-tab gating contract", () => {
  test("context tab body is gated by Show when={sidePanelTab() === \"context\"}", async () => {
    const source = await fs.readFile(SOURCE_PATH, "utf8")
    const block = findTabContentBlock(source, "context")
    expect(block).toContain(`<Show when={sidePanelTab() === "context"}>`)
    expect(block).toContain("<SessionContextTab")
    const showIdx = block.indexOf(`<Show when={sidePanelTab() === "context"}>`)
    const compIdx = block.indexOf("<SessionContextTab")
    expect(compIdx).toBeGreaterThan(showIdx)
  })

  test("terminal tabs are rendered dynamically (one Tabs.Content per terminal id, gated by active)", async () => {
    const source = await fs.readFile(SOURCE_PATH, "utf8")
    // After flatten (Area B 2026-05-25) every terminal is its own outer tab.
    // There's no single Tabs.Content value="terminal" anymore — instead a
    // <For each={terminal.all()}> emits one Tabs.Content per live terminal.
    expect(source).toContain("<For each={terminal.all()}>")
    expect(source).toContain("terminalTabValue(t.tabID)")
    expect(source).toContain("<TerminalPanel tab={t}")
  })
})
