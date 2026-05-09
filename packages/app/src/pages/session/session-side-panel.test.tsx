import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"

let SessionSidePanel: typeof import("./session-side-panel").SessionSidePanel

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
  mock.module("@opencode-ai/ui/tooltip", () => ({ TooltipKeybind: (_props: any) => null }))
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
  mock.module("@/pages/session/files-tab", () => ({ FilesTab: () => null }))
  mock.module("@/pages/session/handoff", () => ({ setSessionHandoff: () => undefined }))
  mock.module("@/pages/session/session-layout", () => ({
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

    expect(sortableShellTabIds(["status", "files", "review", "terminal"])).toEqual(["files", "review", "terminal"])
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
