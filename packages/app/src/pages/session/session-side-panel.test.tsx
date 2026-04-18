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
  mock.module("@/components/file-tree", () => ({ default: () => null }))
  mock.module("@/components/session-context-usage", () => ({ SessionContextUsage: () => null }))
  mock.module("@/components/session", () => ({
    SessionContextTab: () => null,
    SortableTab: () => null,
    FileVisual: () => null,
  }))
  mock.module("@/components/status-panel", () => ({ StatusPanel: () => null }))
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
  mock.module("@/context/layout", () => ({ useLayout: () => ({ session: { width: () => 720 } }) }))
  mock.module("@/pages/session/file-tab-scroll", () => ({ createFileTabListSync: () => () => undefined }))
  mock.module("@/pages/session/file-tabs", () => ({ FileTabContent: () => null }))
  mock.module("@/pages/session/files-tab", () => ({ FilesTab: () => null }))
  mock.module("@/pages/session/helpers", () => ({
    createOpenSessionFileTab: () => () => undefined,
    createSessionTabs: () => ({
      contextOpen: () => false,
      openedTabs: () => [],
      activeTab: () => "review",
      activeFileTab: () => undefined,
    }),
    getTabReorderIndex: () => undefined,
  }))
  mock.module("@/pages/session/handoff", () => ({ setSessionHandoff: () => undefined }))
  mock.module("@/pages/session/session-layout", () => ({
    useSessionLayout: () => ({
      sessionKey: () => "dir/demo",
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
})
