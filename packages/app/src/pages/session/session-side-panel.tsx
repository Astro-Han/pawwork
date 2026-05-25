import { Show, createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js"
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
import { FilesTab } from "@/pages/session/files-tab"
import type { FilesTabEntry } from "@/pages/session/files-tab-state"
import {
  createOpenSessionFileTab,
  createSessionTabs,
  formatRightPanelWidth,
  getTabReorderIndex,
  makeRightPanelResizeHandler,
  openReviewShellTab,
  shouldShowReviewFileOpenButton,
  sortableShellTabIds,
  type Sizing,
} from "@/pages/session/helpers"

export {
  formatRightPanelWidth,
  makeRightPanelResizeHandler,
  shouldShowReviewFileOpenButton,
  sortableShellTabIds,
  openReviewShellTab,
}
import { setSessionHandoff } from "@/pages/session/handoff"
import { RightPanelReviewBody } from "@/pages/session/right-panel-review-body"
import { RightPanelTabStrip } from "@/pages/session/right-panel-tab-strip"
import {
  isRightPanelTab,
  RIGHT_PANEL_TAB_META,
  RIGHT_PANEL_TAB_VALUES,
  type RightPanelShellIconName,
} from "@/pages/session/right-panel-tabs"
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
  terminalPanel?: () => JSX.Element
  size: Sizing
}) {
  const layout = useLayout()
  const file = useFile()
  const language = useLanguage()
  const command = useCommand()
  const dialog = useDialog()
  const { layoutRouteKey, tabs, view } = useSessionLayout()

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
  const shellTabs = createMemo(() =>
    view()
      .sidePanel.openTabs()
      .map((value) => {
        const meta = RIGHT_PANEL_TAB_META[value]
        return {
          value,
          label: language.t(meta.labelKey),
          icon: meta.icon,
          closable: meta.closable,
        }
      }),
  )
  const closableMissingTabs = createMemo(() => {
    const open = new Set(view().sidePanel.openTabs())
    return RIGHT_PANEL_TAB_VALUES.filter((tab) => tab !== "status" && !open.has(tab)).map((value) => {
      const meta = RIGHT_PANEL_TAB_META[value]
      const iconName: RightPanelShellIconName = meta.icon.kind === "icon" ? meta.icon.name : meta.icon.fallbackIcon
      const keybind = meta.commandId ? command.keybind(meta.commandId) : undefined
      return { value, label: language.t(meta.labelKey), iconName, keybind }
    })
  })

  const setSidePanelTabValue = (value: string) => {
    if (!isRightPanelTab(value)) return
    view().sidePanel.openTab(value)
  }
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
  createEffect(() => {
    if (!isDesktop()) return

    if (!open()) {
      if (view().terminal.opened()) view().terminal.close()
      return
    }

    if (sidePanelTab() === "terminal") {
      if (!view().terminal.opened()) view().terminal.open()
      return
    }

    if (view().terminal.opened()) view().terminal.close()
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

    const from = draggable.id.toString()
    const to = droppable.id.toString()
    if (!isRightPanelTab(from) || !isRightPanelTab(to)) return

    const currentTabs = view().sidePanel.openTabs()
    const toIndex = getTabReorderIndex(currentTabs, from, to)
    if (toIndex === undefined) return
    view().sidePanel.moveTab(from, toIndex)
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
                  activeTab={activeTab}
                  openShellTabs={() => view().sidePanel.openTabs()}
                  closeTab={(tab) => view().sidePanel.closeTab(tab)}
                  openTab={(tab) => view().sidePanel.openTab(tab)}
                  closableMissingTabs={closableMissingTabs}
                  openFilePicker={openFilePicker}
                  showAllFiles={showAllFiles}
                  t={language.t}
                  keybind={command.keybind}
                />

                <Tabs.Content value="status" class="min-h-0 flex-1 overflow-hidden">
                  <SessionStatusPanel shown={() => open() && sidePanelTab() === "status"} />
                </Tabs.Content>

                <Tabs.Content value="files" class="min-h-0 flex-1 overflow-hidden">
                  <Show when={sidePanelTab() === "files"}>
                    <FilesTab files={props.files()} />
                  </Show>
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
                    t={language.t}
                    keybind={command.keybind}
                  />
                </Tabs.Content>

                <Tabs.Content value="terminal" class="min-h-0 flex-1 overflow-hidden">
                  <Show when={sidePanelTab() === "terminal"}>
                    <Show
                      when={props.terminalPanel}
                      fallback={<div class="px-4 py-3 text-body text-fg-weak">{language.t("terminal.loading")}</div>}
                    >
                      {(renderTerminal) => renderTerminal()()}
                    </Show>
                  </Show>
                </Tabs.Content>

                <Tabs.Content value="context" class="min-h-0 flex-1 overflow-hidden">
                  <Show when={sidePanelTab() === "context"}>
                    <SessionContextTab />
                  </Show>
                </Tabs.Content>
              </Tabs>
            </DragDropProvider>
          </div>
        </Show>
      </aside>
    </Show>
  )
}
