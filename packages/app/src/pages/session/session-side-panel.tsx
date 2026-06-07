import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { Tabs } from "@opencode-ai/ui/tabs"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { DragDropProvider, DragDropSensors, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import type { SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"
import { ConstrainDragYAxis } from "@/utils/solid-dnd"
import { useDialog } from "@opencode-ai/ui/context/dialog"

import { SessionContextTab } from "@/components/session"
import { SessionStatusPanel } from "@/components/session/session-status-panel"
import { useCommand } from "@/context/command"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { MAX_RIGHT_PANEL_WIDTH, MIN_RIGHT_PANEL_WIDTH, useLayout } from "@/context/layout"
import { canUseBrowser, usePlatform } from "@/context/platform"
import { useTerminal } from "@/context/terminal"
import type { TerminalTabID } from "@/context/terminal-types"
import type { FilesTabEntry } from "@/pages/session/files-tab-state"
import {
  createOpenSessionFileTab,
  createSessionTabs,
  formatRightPanelWidth,
  makeRightPanelResizeHandler,
  openReviewShellTab,
  planShellTabReorder,
  shouldShowReviewFileOpenButton,
  sortableShellTabIds,
  type Sizing,
} from "@/pages/session/helpers"

import { setSessionHandoff } from "@/pages/session/handoff"
import { BrowserPanel } from "@/pages/session/browser/browser-panel"
import { RightPanelReviewBody } from "@/pages/session/right-panel-review-body"
import { RightPanelTabStrip } from "@/pages/session/right-panel-tab-strip"
import {
  isDanglingTerminalSelection,
  isRightPanelTab,
  isRightPanelTerminalTab,
  RIGHT_PANEL_TAB_META,
  RIGHT_PANEL_TAB_VALUES,
  terminalTabId,
  terminalTabValue,
  type RightPanelShellIconName,
  type RightPanelTab,
} from "@/pages/session/right-panel-tabs"
import { computeTerminalLabels } from "@/pages/session/terminal-label"
import { decode64 } from "@/utils/base64"
import { TerminalPanel } from "@/pages/session/terminal-panel"
import { createCloseShellTabRouter } from "@/pages/session/terminal-shell-tab"
import { useSessionLayout } from "@/pages/session/session-layout"

const RIGHT_PANEL_BODY_UNMOUNT_DELAY_MS = 240

/** Hosts the session right panel tabs, resize behavior, and active panel content. */
export function SessionSidePanel(props: {
  canReview: () => boolean
  diffs: () => (SnapshotFileDiff | VcsFileDiff)[]
  hasReview: () => boolean
  reviewCount: () => number
  reviewPanel: () => JSX.Element
  files: () => FilesTabEntry[]
  size: Sizing
}) {
  const layout = useLayout()
  const file = useFile()
  const language = useLanguage()
  const command = useCommand()
  const dialog = useDialog()
  const terminal = useTerminal()
  const platform = usePlatform()
  const { layoutRouteKey, params, tabs, view } = useSessionLayout()

  const isDesktop = createMediaQuery("(min-width: 768px)")

  const open = createMemo(() => isDesktop() && view().sidePanel.opened())
  const reviewTab = createMemo(() => isDesktop())
  const sidePanelTab = createMemo(() => view().sidePanel.tab())
  const panelWidth = createMemo(() => formatRightPanelWidth(open(), layout.rightPanel.width()))
  const [bodyMounted, setBodyMounted] = createSignal(open())
  // Tabs render into the titlebar so they read as window chrome instead of a
  // second toolbar. Portal preserves the virtual tree, so Tabs/Sortable/DnD
  // contexts still flow to the moved <Tabs.List>. Mount lookup is deferred to
  // onMount because the titlebar slot is created by <Titlebar> at the shell
  // root — by the time SessionSidePanel mounts it always exists.
  const [tabsPortalMount, setTabsPortalMount] = createSignal<HTMLElement>()
  onMount(() => {
    setTabsPortalMount(document.getElementById("pawwork-titlebar-tabs") ?? undefined)
  })
  let bodyUnmountTimer: number | undefined

  const clearBodyUnmountTimer = () => {
    if (bodyUnmountTimer === undefined) return
    window.clearTimeout(bodyUnmountTimer)
    bodyUnmountTimer = undefined
  }

  const normalizeTab = (tab: string) => {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  const openReviewPanel = () => {
    openReviewShellTab(view().sidePanel)
  }

  const openTab = createOpenSessionFileTab({
    normalizeTab,
    openTab: tabs().open,
    pathFromTab: file.pathFromTab,
    loadFile: file.load,
    openReviewPanel,
    setActive: tabs().setActive,
  })

  const tabState = createSessionTabs({
    tabs,
    pathFromTab: file.pathFromTab,
    normalizeTab,
    review: reviewTab,
    hasReview: props.canReview,
  })
  const openedTabs = tabState.openedTabs
  const activeTab = tabState.activeTab
  const activeFileTab = tabState.activeFileTab
  const showSecondaryReviewTabs = createMemo(() => openedTabs().length > 0)

  // The terminal subset of shell tabs is derived from terminal.all() — never
  // persisted in openShellTabs. Labels: cwd basename (session dir) with same-
  // name dedup; user rename wins. See computeTerminalLabels.
  const terminalLabels = createMemo(() => {
    const cwd = decode64(params.dir)
    return computeTerminalLabels(
      terminal.all().map((t) => ({ tabID: t.tabID, title: t.title, titleNumber: t.titleNumber, cwd })),
      { t: language.t },
    )
  })

  const shellTabs = createMemo(() => {
    const staticTabs = view()
      .sidePanel.openTabs()
      // Browser is desktop/Electron only; drop a persisted chip on web.
      .filter((value) => value !== "browser" || canUseBrowser(platform))
      .map((value) => {
        const meta = RIGHT_PANEL_TAB_META[value]
        return {
          value: value as RightPanelTab,
          label: language.t(meta.labelKey),
          icon: meta.icon,
          closable: meta.closable,
        }
      })
    const labels = terminalLabels()
    const terms = terminal.all().map((t) => ({
      value: terminalTabValue(t.tabID),
      label: labels.get(t.tabID) ?? "",
      icon: { kind: "icon" as const, name: "terminal" as const },
      closable: true,
    }))
    // Layout: pinned status + closable static (files/review/context in user
    // order) + terminals. Terminals always trail static; cross-group drag is
    // a no-op (see planShellTabReorder).
    return [...staticTabs, ...terms]
  })

  const closableMissingTabs = createMemo(() => {
    const open = new Set(view().sidePanel.openTabs())
    return RIGHT_PANEL_TAB_VALUES.filter(
      (tab) => tab !== "status" && !open.has(tab) && (tab !== "browser" || canUseBrowser(platform)),
    ).map((value) => {
      const meta = RIGHT_PANEL_TAB_META[value]
      const iconName: RightPanelShellIconName = meta.icon.kind === "icon" ? meta.icon.name : meta.icon.fallbackIcon
      const keybind = meta.commandId ? command.keybind(meta.commandId) : undefined
      return { value, label: language.t(meta.labelKey), iconName, keybind }
    })
  })

  const setSidePanelTabValue = (value: string) => {
    if (!isRightPanelTab(value)) return
    if (isRightPanelTerminalTab(value)) {
      const id = terminalTabId(value)
      // Guard against stale tab values: a deeplink or persisted active id may
      // point at a terminal that no longer exists. Drop the activation
      // silently rather than calling terminal.open with an unknown id.
      const exists = terminal.all().some((t) => (t.tabID as string) === id)
      if (!exists) return
      terminal.open(id as TerminalTabID)
    }
    view().sidePanel.openTab(value)
  }

  const closeShellTabValue = createCloseShellTabRouter({ view, terminal: () => terminal })

  // Stale terminal selector guard: persisted sidePanelTab may carry a
  // `terminal:<id>` whose terminal no longer exists after restart. If we
  // render that selector, the panel body shows nothing because the matching
  // <Tabs.Content> isn't in the For loop. Fall back to status when we detect
  // a dangling reference — but only once terminal persistence has hydrated
  // (terminal.ready()), since terminal.all() is empty until then and would
  // otherwise mis-detect a freshly-restored active terminal as dangling and
  // bounce the user to Status. ready() is reactive, so this re-validates when
  // the terminal store loads.
  createEffect(() => {
    const tab = sidePanelTab()
    const ids = terminal.all().map((t) => t.tabID as string)
    if (isDanglingTerminalSelection(tab, terminal.ready(), ids)) {
      // Correct the selection without forcing the panel open. openTab("status")
      // ends in this.open() and would pop a panel the user had closed; closeTab
      // routes the dangling terminal through closeShellTab, which shifts
      // sidePanelTab to status and leaves the panel's open/closed state alone.
      view().sidePanel.closeTab(tab)
    }
  })
  // Stale browser selector guard (sibling to the dangling-terminal guard
  // above): browser is desktop/Electron only, so a session persisted with the
  // tab open can be restored where the platform lacks it — the feature
  // flag-disabled or rolled back. Its chip is already filtered out, but a
  // persisted active "browser" tab would leave the panel on a value whose
  // <Tabs.Content> never mounts (blank body). Drop it so the selection falls
  // back to a real tab.
  createEffect(() => {
    if (canUseBrowser(platform)) return
    if (!view().sidePanel.openTabs().includes("browser")) return
    view().sidePanel.closeTab("browser")
  })

  const showAllFiles = () => {
    if (view().sidePanel.explorer.tab() !== "changes") return
    view().sidePanel.explorer.setTab("all")
  }

  // Mirror right-panel drag-resize state to the desktop shell so the CSS
  // `--right-panel-width` transition on `<desktop-shell>` can be suppressed
  // while the user is dragging. Without this, the aside's inline `width`
  // (gated on `props.size.active()`) snaps to the new value on every
  // pointermove, but `--right-panel-width` is set on the desktop-shell —
  // which uses `state.sizing` (a layout.tsx-local flag scoped to the
  // sidebar resize handler only) as its transition gate. During right-panel
  // drag the var keeps its 240ms cubic-bezier transition, so the titlebar
  // tabs slot (whose width follows the var) lags behind the body. The
  // attribute lets a CSS rule in `index.css` turn the var transition off
  // for the drag without needing to plumb session-scope sizing state up
  // into the global layout context.
  //
  // The effect must guard against three leak paths that would lock the
  // shell's transition off indefinitely (CSS rule is `!important`):
  //  1. Viewport shrinks mid-drag and `isDesktop()` flips to false — the
  //     early-return must not skip removing the attribute.
  //  2. Navigation away from the session route unmounts SessionSidePanel
  //     while drag is still "active" — `onCleanup` must remove the
  //     attribute even if `props.size.active()` is still true.
  //  3. Component re-mount finds a stale attribute from a previous
  //     instance — we always clear before optionally re-setting.
  createEffect(() => {
    const shell = document.querySelector<HTMLElement>('[data-component="desktop-shell"]')
    if (!shell) return
    // Always clear first; only re-set when desktop AND actively resizing.
    shell.removeAttribute("data-resizing-right-panel")
    if (!isDesktop()) return
    if (props.size.active()) shell.setAttribute("data-resizing-right-panel", "")
  })

  onCleanup(() => {
    document
      .querySelector<HTMLElement>('[data-component="desktop-shell"]')
      ?.removeAttribute("data-resizing-right-panel")
  })
  // Mirror "is a terminal currently visible?" to the legacy view().terminal
  // signal. Terminal tabs flatten into right-panel tabs (Area B 2026-05-25),
  // so the legacy boolean is now derived from sidePanelTab rather than a
  // separate user toggle. Kept alive for callers like session.tsx and
  // command-palette which still read terminalOpened().
  createEffect(() => {
    if (!isDesktop()) return
    const wantOpen = open() && isRightPanelTerminalTab(sidePanelTab())
    if (wantOpen && !view().terminal.opened()) view().terminal.open()
    if (!wantOpen && view().terminal.opened()) view().terminal.close()
  })

  createEffect(() => {
    if (open()) {
      clearBodyUnmountTimer()
      setBodyMounted(true)
      return
    }

    clearBodyUnmountTimer()
    if (!bodyMounted()) return

    bodyUnmountTimer = window.setTimeout(() => {
      bodyUnmountTimer = undefined
      setBodyMounted(false)
    }, RIGHT_PANEL_BODY_UNMOUNT_DELAY_MS)
  })

  onCleanup(clearBodyUnmountTimer)

  const handleShellDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return

    const plan = planShellTabReorder({
      draggableId: draggable.id.toString(),
      droppableId: droppable.id.toString(),
      openStatic: view().sidePanel.openTabs(),
      terminalIds: terminal.all().map((t) => t.tabID),
    })
    if (!plan) return
    if (plan.kind === "static") {
      view().sidePanel.moveTab(plan.target, plan.to)
    } else {
      terminal.move(plan.target as TerminalTabID, plan.to)
    }
  }

  const openFilePicker = (onOpenFile?: () => void) => {
    void import("@/components/dialog-select-file").then((x) => {
      dialog.show(() => <x.DialogSelectFile mode="files" onOpenFile={onOpenFile} />)
    })
  }

  createEffect(() => {
    if (!file.ready()) return

    setSessionHandoff(layoutRouteKey(), {
      files: tabs()
        .all()
        .reduce<Record<string, SelectedLineRange | null>>((acc, tab) => {
          const path = file.pathFromTab(tab)
          if (!path) return acc

          const selected = file.selectedLines(path)
          acc[path] =
            selected && typeof selected === "object" && "start" in selected && "end" in selected
              ? (selected as SelectedLineRange)
              : null

          return acc
        }, {}),
    })
  })

  return (
    <Show when={isDesktop()}>
      <aside
        id="right-panel"
        data-component="right-panel"
        aria-label={language.t("session.panel.utility")}
        aria-hidden={!open()}
        inert={!open()}
        class="relative min-w-0 h-full flex shrink-0 overflow-hidden bg-bg-base"
        classList={{
          "pointer-events-none": !open(),
          "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
            !props.size.active(),
        }}
        style={{ width: panelWidth() }}
      >
        <div
          data-component="right-panel-resize-wrapper"
          onPointerDown={() => props.size.start()}
          class="absolute top-0 left-0 h-full z-10"
        >
          <ResizeHandle
            direction="horizontal"
            edge="start"
            size={layout.rightPanel.width()}
            min={MIN_RIGHT_PANEL_WIDTH}
            max={MAX_RIGHT_PANEL_WIDTH}
            onResize={makeRightPanelResizeHandler(props.size, layout)}
          />
        </div>
        <Show when={bodyMounted()}>
          <div data-component="right-panel-body" class="size-full border-l border-border-weaker">
            <DragDropProvider onDragOver={handleShellDragOver} collisionDetector={closestCenter}>
              <DragDropSensors />
              <ConstrainDragYAxis />
              <Tabs
                variant="sidepanel"
                value={sidePanelTab()}
                onChange={setSidePanelTabValue}
                class="h-full flex flex-col"
                data-scope="right-panel"
              >
                <RightPanelTabStrip
                  tabsPortalMount={tabsPortalMount}
                  shellTabs={shellTabs}
                  openShellTabs={() =>
                    [
                      ...view().sidePanel.openTabs(),
                      ...terminal.all().map((t) => terminalTabValue(t.tabID)),
                    ] as RightPanelTab[]
                  }
                  closeTab={closeShellTabValue}
                  openTab={setSidePanelTabValue}
                  closableMissingTabs={closableMissingTabs}
                  openFilePicker={openFilePicker}
                  showAllFiles={showAllFiles}
                />

                <Tabs.Content value="status" class="min-h-0 flex-1 overflow-hidden">
                  <SessionStatusPanel
                    shown={() => open() && sidePanelTab() === "status"}
                    artifactFiles={props.files}
                    onNavigateReview={() => setSidePanelTabValue("review")}
                  />
                </Tabs.Content>

                <Tabs.Content value="review" class="min-h-0 flex-1 overflow-hidden">
                  <RightPanelReviewBody
                    canReview={props.canReview}
                    hasReview={props.hasReview}
                    reviewCount={props.reviewCount}
                    reviewPanel={props.reviewPanel}
                    activeTab={activeTab}
                    activeFileTab={activeFileTab}
                    openedTabs={openedTabs}
                    showSecondaryReviewTabs={showSecondaryReviewTabs}
                    openTab={openTab}
                    openFilePicker={openFilePicker}
                    showAllFiles={showAllFiles}
                    tabs={{ all: tabs().all, close: tabs().close, move: tabs().move }}
                    pathFromTab={file.pathFromTab}
                    reviewTab={reviewTab}
                  />
                </Tabs.Content>

                <For each={terminal.all()}>
                  {(t) => {
                    const value = terminalTabValue(t.tabID)
                    const active = createMemo(() => sidePanelTab() === value)
                    return (
                      <Tabs.Content value={value} class="min-h-0 flex-1 overflow-hidden">
                        <Show when={active()}>
                          <TerminalPanel tab={t} active={active} />
                        </Show>
                      </Tabs.Content>
                    )
                  }}
                </For>

                <Tabs.Content value="context" class="min-h-0 flex-1 overflow-hidden">
                  <Show when={sidePanelTab() === "context"}>
                    <SessionContextTab />
                  </Show>
                </Tabs.Content>

                <Show when={platform.browser}>
                  {(bridge) => (
                    <Tabs.Content value="browser" class="min-h-0 flex-1 overflow-hidden">
                      <BrowserPanel
                        bridge={bridge()}
                        active={() => sidePanelTab() === "browser"}
                        panelOpen={open}
                      />
                    </Tabs.Content>
                  )}
                </Show>
              </Tabs>
            </DragDropProvider>
          </div>
        </Show>
      </aside>
    </Show>
  )
}

export {
  formatRightPanelWidth,
  makeRightPanelResizeHandler,
  shouldShowReviewFileOpenButton,
  sortableShellTabIds,
  openReviewShellTab,
}
