import type { Accessor } from "solid-js"
import { decode64 } from "@/utils/base64"
import { same } from "@/utils/same"
import { isRecord } from "@/utils/is-record"
import { createPathHelpers } from "./file/path"
import { defaultRightPanelTab, normalizeShellTabs, type RightPanelTab } from "@/pages/session/right-panel-tabs"
import { migrateSessionView } from "@/pages/session/migrate-session-view"
import type { SessionScroll } from "./layout-scroll"

const DEFAULT_SIDEBAR_WIDTH = 344
export const DEFAULT_FILE_TREE_WIDTH = 200
export const DEFAULT_SESSION_WIDTH = 600
export const DEFAULT_TERMINAL_HEIGHT = 280
export const DEFAULT_RIGHT_PANEL_WIDTH = 380
export const MIN_RIGHT_PANEL_WIDTH = 360
export const MAX_RIGHT_PANEL_WIDTH = 520

export const AVATAR_COLOR_KEYS = ["pink", "mint", "orange", "purple", "cyan", "lime"] as const
export type AvatarColorKey = (typeof AVATAR_COLOR_KEYS)[number]

export function clampRightPanelWidth(raw: number | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_RIGHT_PANEL_WIDTH
  return Math.max(MIN_RIGHT_PANEL_WIDTH, Math.min(MAX_RIGHT_PANEL_WIDTH, raw))
}

type SessionTabs = {
  active?: string
  all: string[]
}

type SessionView = {
  scroll: Record<string, SessionScroll>
  reviewOpen?: string[]
  openShellTabs?: RightPanelTab[]
  sidePanelTab?: RightPanelTab | "changes"
  pendingMessage?: string
  pendingMessageAt?: number
}

type TabHandoff = {
  dir: string
  id: string
  at: number
}

export type ReviewDiffStyle = "unified" | "split"

export function ensureSessionKey(key: string, touch: (key: string) => void, seed: (key: string) => void) {
  touch(key)
  seed(key)
  return key
}

export function createSessionKeyReader(sessionKey: string | Accessor<string>, ensure: (key: string) => void) {
  const key = typeof sessionKey === "function" ? sessionKey : () => sessionKey
  return () => {
    const value = key()
    ensure(value)
    return value
  }
}

export function defaultSidePanelTab(tab?: RightPanelTab | "changes") {
  return defaultRightPanelTab(tab)
}

export function legacyOpenShellTabs(openShellTabs: unknown, sidePanelTab?: RightPanelTab | "changes"): RightPanelTab[] {
  if (Array.isArray(openShellTabs)) {
    const normalized = normalizeShellTabs({ openShellTabs, sidePanelTab })
    return normalized.openShellTabs
  }

  const active = defaultSidePanelTab(sidePanelTab)
  return active === "status" ? ["status"] : ["status", active]
}

export function pruneSessionKeys(input: {
  keep?: string
  max: number
  used: Map<string, number>
  view: string[]
  tabs: string[]
}) {
  if (!input.keep) return []

  const keys = new Set<string>([...input.view, ...input.tabs])
  if (keys.size <= input.max) return []

  const score = (key: string) => {
    if (key === input.keep) return Number.MAX_SAFE_INTEGER
    return input.used.get(key) ?? 0
  }

  return Array.from(keys)
    .sort((a, b) => score(b) - score(a))
    .slice(input.max)
}

export function nextSessionTabsForOpen(current: SessionTabs | undefined, tab: string): SessionTabs {
  const all = current?.all ?? []
  if (tab === "review") return { all: all.filter((x) => x !== "review"), active: tab }
  if (tab === "context") return { all: [tab, ...all.filter((x) => x !== tab)], active: tab }
  if (!all.includes(tab)) return { all: [...all, tab], active: tab }
  return { all, active: tab }
}

export const sessionPath = (key: string) => {
  const dir = key.split("/")[0]
  if (!dir) return
  const root = decode64(dir)
  if (!root) return
  return createPathHelpers(() => root)
}

export const normalizeSessionTab = (path: ReturnType<typeof createPathHelpers> | undefined, tab: string) => {
  if (!tab.startsWith("file://")) return tab
  if (!path) return tab
  return path.tab(tab)
}

export const normalizeSessionTabList = (path: ReturnType<typeof createPathHelpers> | undefined, all: string[]) => {
  const seen = new Set<string>()
  return all.flatMap((tab) => {
    const value = normalizeSessionTab(path, tab)
    if (seen.has(value)) return []
    seen.add(value)
    return [value]
  })
}

const normalizeStoredSessionTabs = (key: string, tabs: SessionTabs) => {
  const path = sessionPath(key)
  return {
    all: normalizeSessionTabList(path, tabs.all),
    active: tabs.active ? normalizeSessionTab(path, tabs.active) : tabs.active,
  }
}

export function createDefaultLayoutState() {
  return {
    sidebar: {
      opened: false,
      width: DEFAULT_SIDEBAR_WIDTH,
      workspaces: {} as Record<string, boolean>,
      workspacesDefault: false,
    },
    terminal: {
      height: DEFAULT_TERMINAL_HEIGHT,
      opened: false,
    },
    review: {
      diffStyle: "unified" as ReviewDiffStyle,
      panelOpened: false,
    },
    fileTree: {
      opened: false,
      width: DEFAULT_FILE_TREE_WIDTH,
      tab: "changes" as "changes" | "all",
    },
    session: {
      width: DEFAULT_SESSION_WIDTH,
    },
    rightPanel: {
      width: DEFAULT_RIGHT_PANEL_WIDTH,
      opened: false,
    },
    sessionTabs: {} as Record<string, SessionTabs>,
    sessionView: {} as Record<string, SessionView>,
    handoff: {
      tabs: undefined as TabHandoff | undefined,
    },
  }
}

export function legacyRightPanelOpened(rightPanel: unknown, review: unknown, fileTree: unknown): boolean {
  if (isRecord(rightPanel) && typeof rightPanel.opened === "boolean") return rightPanel.opened
  if (isRecord(review) && typeof review.panelOpened === "boolean") return review.panelOpened
  if (isRecord(fileTree) && typeof fileTree.opened === "boolean") return fileTree.opened
  return true
}

export function migrateStoredLayout(value: unknown) {
  if (!isRecord(value)) return value

  const sidebar = value.sidebar
  const migratedSidebar = (() => {
    if (!isRecord(sidebar)) return sidebar
    if (typeof sidebar.workspaces !== "boolean") return sidebar
    return {
      ...sidebar,
      workspaces: {},
      workspacesDefault: sidebar.workspaces,
    }
  })()

  const review = value.review
  const fileTree = value.fileTree
  const migratedFileTree = (() => {
    if (!isRecord(fileTree)) return fileTree
    if (fileTree.tab === "changes" || fileTree.tab === "all") return fileTree

    const width = typeof fileTree.width === "number" ? fileTree.width : DEFAULT_FILE_TREE_WIDTH
    return {
      ...fileTree,
      opened: true,
      width: width === 260 ? DEFAULT_FILE_TREE_WIDTH : width,
      tab: "changes",
    }
  })()

  const rightPanel = value.rightPanel
  const migratedRightPanel = (() => {
    const opened = legacyRightPanelOpened(rightPanel, review, fileTree)
    if (typeof rightPanel === "boolean") return { width: DEFAULT_RIGHT_PANEL_WIDTH, opened: rightPanel }
    if (!isRecord(rightPanel)) return { width: DEFAULT_RIGHT_PANEL_WIDTH, opened }
    if (typeof rightPanel.opened === "boolean") return rightPanel
    return { ...rightPanel, opened }
  })()

  const migratedReview = (() => {
    if (!isRecord(review)) return review
    if (typeof review.panelOpened === "boolean") return review

    const opened = isRecord(fileTree) && typeof fileTree.opened === "boolean" ? fileTree.opened : true
    return {
      ...review,
      panelOpened: opened,
    }
  })()

  const sessionTabs = value.sessionTabs
  const migratedSessionTabs = (() => {
    if (!isRecord(sessionTabs)) return sessionTabs

    let changed = false
    const next = Object.fromEntries(
      Object.entries(sessionTabs).map(([key, tabs]) => {
        if (!isRecord(tabs) || !Array.isArray(tabs.all)) return [key, tabs]

        const current = {
          all: tabs.all.filter((tab): tab is string => typeof tab === "string"),
          active: typeof tabs.active === "string" ? tabs.active : undefined,
        }
        const normalized = normalizeStoredSessionTabs(key, current)
        if (current.all.length !== tabs.all.length) changed = true
        if (!same(current.all, normalized.all) || current.active !== normalized.active) changed = true
        if (tabs.active !== undefined && typeof tabs.active !== "string") changed = true
        return [key, normalized]
      }),
    )

    if (!changed) return sessionTabs
    return next
  })()

  const sessionViewMigration = migrateSessionView(value.sessionView, migratedSessionTabs)
  const sessionStateChanged = sessionViewMigration.changed

  const hasMobileSidebar = "mobileSidebar" in value

  if (
    migratedSidebar === sidebar &&
    migratedReview === review &&
    migratedFileTree === fileTree &&
    migratedRightPanel === rightPanel &&
    migratedSessionTabs === sessionTabs &&
    !sessionStateChanged &&
    !hasMobileSidebar
  ) {
    return value
  }

  const { mobileSidebar: _mobileSidebar, ...rest } = value as Record<string, unknown>
  return {
    ...rest,
    sidebar: migratedSidebar,
    review: migratedReview,
    fileTree: migratedFileTree,
    rightPanel: migratedRightPanel,
    sessionView: sessionViewMigration.sessionView,
    sessionTabs: sessionViewMigration.sessionTabs,
  }
}
