import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
import { Tabs } from "@opencode-ai/ui/tabs"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Mark } from "@opencode-ai/ui/logo"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import type { SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"
import { useDialog } from "@opencode-ai/ui/context/dialog"

import FileTree from "@/components/file-tree"
import { SessionContextUsage } from "@/components/session-context-usage"
import { SessionContextTab, SortableTab, FileVisual } from "@/components/session"
import { StatusPanel } from "@/components/status-panel"
import { useCommand } from "@/context/command"
import { useFile, type SelectedLineRange } from "@/context/file"
import { useLanguage } from "@/context/language"
import { MAX_RIGHT_PANEL_WIDTH, MIN_RIGHT_PANEL_WIDTH, useLayout } from "@/context/layout"
import { createFileTabListSync } from "@/pages/session/file-tab-scroll"
import { FileTabContent } from "@/pages/session/file-tabs"
import { FilesTab } from "@/pages/session/files-tab"
import type { FilesTabEntry } from "@/pages/session/files-tab-state"
import { createOpenSessionFileTab, createSessionTabs, getTabReorderIndex, type Sizing } from "@/pages/session/helpers"
import { setSessionHandoff } from "@/pages/session/handoff"
import type { RightPanelTab } from "@/pages/session/right-panel-tabs"
import { useSessionLayout } from "@/pages/session/session-layout"

export function formatRightPanelWidth(open: boolean, width: number): string {
  return open ? `${width}px` : "0px"
}

export function makeRightPanelResizeHandler(
  size: { touch: () => void },
  layout: { rightPanel: { resize: (width: number) => void } },
): (width: number) => void {
  return (width) => {
    size.touch()
    layout.rightPanel.resize(width)
  }
}

type RightPanelShellIconName = "status" | "folder" | "review" | "terminal"

function RightPanelShellIcon(props: { icon: RightPanelShellIconName }) {
  return (
    <Switch>
      <Match when={props.icon === "status"}>
        <Icon name="status" size="small" class="text-text-weaker" />
      </Match>
      <Match when={props.icon === "folder"}>
        <Icon name="folder" size="small" class="text-text-weaker" />
      </Match>
      <Match when={props.icon === "review"}>
        <Icon name="review" size="small" class="text-text-weaker" />
      </Match>
      <Match when={props.icon === "terminal"}>
        <Icon name="terminal" size="small" class="text-text-weaker" />
      </Match>
    </Switch>
  )
}

export function SessionSidePanel(props: {
  canReview: () => boolean
  diffs: () => (SnapshotFileDiff | VcsFileDiff)[]
  diffsReady: () => boolean
  empty: () => string
  hasReview: () => boolean
  reviewCount: () => number
  reviewPanel: () => JSX.Element
  files: () => FilesTabEntry[]
  terminalPanel?: () => JSX.Element
  activeDiff?: string
  focusReviewDiff: (path: string) => void
  size: Sizing
}) {
  const layout = useLayout()
  const file = useFile()
  const language = useLanguage()
  const command = useCommand()
  const dialog = useDialog()
  const { sessionKey, tabs, view } = useSessionLayout()

  const isDesktop = createMediaQuery("(min-width: 768px)")

  const open = createMemo(() => isDesktop() && view().sidePanel.opened())
  const reviewTab = createMemo(() => isDesktop())
  const sidePanelTab = createMemo(() => view().sidePanel.tab())
  const panelWidth = createMemo(() => formatRightPanelWidth(open(), layout.rightPanel.width()))
  const treeWidth = createMemo(() => `${view().sidePanel.explorer.width()}px`)

  const diffFiles = createMemo(() => props.diffs().map((d) => d.file))
  const kinds = createMemo(() => {
    const merge = (a: "add" | "del" | "mix" | undefined, b: "add" | "del" | "mix") => {
      if (!a) return b
      if (a === b) return a
      return "mix" as const
    }

    const normalize = (p: string) => p.replaceAll("\\\\", "/").replace(/\/+$/, "")

    const out = new Map<string, "add" | "del" | "mix">()
    for (const diff of props.diffs()) {
      const file = normalize(diff.file)
      const kind = diff.status === "added" ? "add" : diff.status === "deleted" ? "del" : "mix"

      out.set(file, kind)

      const parts = file.split("/")
      for (const [idx] of parts.slice(0, -1).entries()) {
        const dir = parts.slice(0, idx + 1).join("/")
        if (!dir) continue
        out.set(dir, merge(out.get(dir), kind))
      }
    }
    return out
  })

  const empty = (msg: string) => (
    <div class="h-full flex flex-col">
      <div class="h-6 shrink-0" aria-hidden />
      <div class="flex-1 pb-64 flex items-center justify-center text-center">
        <div class="text-12-regular text-text-weak">{msg}</div>
      </div>
    </div>
  )

  const nofiles = createMemo(() => {
    const state = file.tree.state("")
    if (!state?.loaded) return false
    return file.tree.children("").length === 0
  })

  const normalizeTab = (tab: string) => {
    if (!tab.startsWith("file://")) return tab
    return file.tab(tab)
  }

  const openReviewPanel = () => {
    if (!view().reviewPanel.opened()) view().reviewPanel.open()
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
  const contextOpen = tabState.contextOpen
  const openedTabs = tabState.openedTabs
  const activeTab = tabState.activeTab
  const activeFileTab = tabState.activeFileTab
  const showSecondaryReviewTabs = createMemo(() => contextOpen() || openedTabs().length > 0)
  const shellTabs = createMemo(
    () =>
      [
        { value: "status", label: language.t("status.popover.trigger"), icon: "status" as const },
        { value: "files", label: language.t("session.panel.files"), icon: "folder" as const },
        { value: "review", label: language.t("session.tab.review"), icon: "review" as const },
        { value: "terminal", label: language.t("terminal.title"), icon: "terminal" as const },
      ] satisfies Array<{
        value: RightPanelTab
        label: string
        icon: RightPanelShellIconName
      }>,
  )

  const setSidePanelTabValue = (value: string) => {
    if (value !== "status" && value !== "files" && value !== "review" && value !== "terminal") return
    view().sidePanel.setTab(value as RightPanelTab)
    view().sidePanel.open()
  }
  const fileTreeTab = () => view().sidePanel.explorer.tab()
  const setFileTreeTabValue = (value: string) => {
    if (value !== "changes" && value !== "all") return
    view().sidePanel.explorer.setTab(value)
  }
  const showAllFiles = () => {
    if (fileTreeTab() !== "changes") return
    view().sidePanel.explorer.setTab("all")
  }

  const [store, setStore] = createStore({
    activeDraggable: undefined as string | undefined,
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

  const handleDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeDraggable", id)
  }

  const handleDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return

    const currentTabs = tabs().all()
    const toIndex = getTabReorderIndex(currentTabs, draggable.id.toString(), droppable.id.toString())
    if (toIndex === undefined) return
    tabs().move(draggable.id.toString(), toIndex)
  }

  const handleDragEnd = () => {
    setStore("activeDraggable", undefined)
  }

  const openFilePicker = (onOpenFile?: () => void) => {
    void import("@/components/dialog-select-file").then((x) => {
      dialog.show(() => <x.DialogSelectFile mode="files" onOpenFile={onOpenFile} />)
    })
  }

  createEffect(() => {
    if (!file.ready()) return

    setSessionHandoff(sessionKey(), {
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
        aria-label={language.t("session.panel.utility")}
        aria-hidden={!open()}
        inert={!open()}
        class="relative min-w-0 h-full flex shrink-0 overflow-hidden bg-background-base"
        classList={{
          "pointer-events-none": !open(),
          "transition-[width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-[width] motion-reduce:transition-none":
            !props.size.active(),
        }}
        style={{ width: panelWidth() }}
      >
        <div
          data-testid="right-panel-resize-wrapper"
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
        <div class="size-full border-l border-border-weaker-base">
          <Tabs
            variant="sidepanel"
            value={sidePanelTab()}
            onChange={setSidePanelTabValue}
            class="h-full flex flex-col"
            data-scope="right-panel"
          >
            <Tabs.List class="h-11 shrink-0 px-2 py-0 border-b border-border-weaker-base gap-1 items-center">
              <For each={shellTabs()}>
                {(tab) => (
                  <Tabs.Trigger
                    value={tab.value}
                    class="shrink-0 h-7"
                    classes={{
                      button:
                        "h-7 min-h-7 inline-flex items-center whitespace-nowrap rounded-md text-12-medium text-text-weak gap-1.5 px-2.5",
                    }}
                  >
                    <RightPanelShellIcon icon={tab.icon} />
                    <span>{tab.label}</span>
                  </Tabs.Trigger>
                )}
              </For>
              <div class="flex-1" />
              {/* 40px right-gutter reserve — matches docs/design/src/rightpanel.jsx,
                  gives the tab row breathing room against the panel edge. */}
              <div class="w-10 shrink-0" aria-hidden />
            </Tabs.List>

            <Tabs.Content value="status" class="min-h-0 flex-1 overflow-hidden">
              <StatusPanel shown={open} />
            </Tabs.Content>

            <Tabs.Content value="files" class="min-h-0 flex-1 overflow-hidden">
              <FilesTab files={props.files()} />
            </Tabs.Content>

            <Tabs.Content value="review" class="min-h-0 flex-1 overflow-hidden">
              <div class="size-full flex">
                <div class="relative min-w-0 h-full flex-1 overflow-hidden bg-background-base">
                  <div class="size-full min-w-0 h-full bg-background-base">
                    <DragDropProvider
                      onDragStart={handleDragStart}
                      onDragEnd={handleDragEnd}
                      onDragOver={handleDragOver}
                      collisionDetector={closestCenter}
                    >
                      <DragDropSensors />
                      <ConstrainDragYAxis />
                      <Tabs value={activeTab()} onChange={openTab}>
                        <div class="sticky top-0 shrink-0 flex">
                          <Show
                            when={showSecondaryReviewTabs()}
                            fallback={
                              <div class="w-full bg-background-stronger flex items-center justify-end px-3 py-1.5">
                                <TooltipKeybind
                                  title={language.t("command.file.open")}
                                  keybind={command.keybind("file.open")}
                                  class="flex items-center"
                                >
                                  <IconButton
                                    icon="plus-small"
                                    variant="ghost"
                                    iconSize="large"
                                    class="!rounded-md"
                                    onClick={() => openFilePicker(showAllFiles)}
                                    aria-label={language.t("command.file.open")}
                                  />
                                </TooltipKeybind>
                              </div>
                            }
                          >
                            <Tabs.List
                              ref={(el: HTMLDivElement) => {
                                const stop = createFileTabListSync({ el, contextOpen })
                                onCleanup(stop)
                              }}
                            >
                              <Show when={reviewTab() && props.canReview()}>
                                <Tabs.Trigger value="review">
                                  <div class="flex items-center gap-1.5">
                                    <div>{language.t("session.tab.review")}</div>
                                    <Show when={props.hasReview()}>
                                      <div>{props.reviewCount()}</div>
                                    </Show>
                                  </div>
                                </Tabs.Trigger>
                              </Show>
                              <Show when={contextOpen()}>
                                <Tabs.Trigger
                                  value="context"
                                  closeButton={
                                    <TooltipKeybind
                                      title={language.t("common.closeTab")}
                                      keybind={command.keybind("tab.close")}
                                      placement="bottom"
                                      gutter={10}
                                    >
                                      <IconButton
                                        icon="close-small"
                                        variant="ghost"
                                        class="h-5 w-5"
                                        onClick={() => tabs().close("context")}
                                        aria-label={language.t("common.closeTab")}
                                      />
                                    </TooltipKeybind>
                                  }
                                  hideCloseButton
                                  onMiddleClick={() => tabs().close("context")}
                                >
                                  <div class="flex items-center gap-2">
                                    <SessionContextUsage variant="indicator" />
                                    <div>{language.t("session.tab.context")}</div>
                                  </div>
                                </Tabs.Trigger>
                              </Show>
                              <SortableProvider ids={openedTabs()}>
                                <For each={openedTabs()}>{(tab) => <SortableTab tab={tab} onTabClose={tabs().close} />}</For>
                              </SortableProvider>
                              <div class="bg-background-stronger h-full shrink-0 sticky right-0 z-10 flex items-center justify-center pr-3">
                                <TooltipKeybind
                                  title={language.t("command.file.open")}
                                  keybind={command.keybind("file.open")}
                                  class="flex items-center"
                                >
                                  <IconButton
                                    icon="plus-small"
                                    variant="ghost"
                                    iconSize="large"
                                    class="!rounded-md"
                                    onClick={() => openFilePicker(showAllFiles)}
                                    aria-label={language.t("command.file.open")}
                                  />
                                </TooltipKeybind>
                              </div>
                            </Tabs.List>
                          </Show>
                        </div>

                        <Show when={reviewTab() && props.canReview()}>
                          <Tabs.Content value="review" class="flex flex-col h-full overflow-hidden contain-strict">
                            <Show when={activeTab() === "review"}>{props.reviewPanel()}</Show>
                          </Tabs.Content>
                        </Show>

                        <Tabs.Content value="empty" class="flex flex-col h-full overflow-hidden contain-strict">
                          <Show when={activeTab() === "empty"}>
                            <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                              <div class="h-full px-6 pb-42 -mt-4 flex flex-col items-center justify-center text-center gap-6">
                                <Mark class="w-14 opacity-10" />
                                <div class="text-14-regular text-text-weak max-w-56">
                                  {language.t("session.files.selectToOpen")}
                                </div>
                              </div>
                            </div>
                          </Show>
                        </Tabs.Content>

                        <Show when={contextOpen()}>
                          <Tabs.Content value="context" class="flex flex-col h-full overflow-hidden contain-strict">
                            <Show when={activeTab() === "context"}>
                              <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                                <SessionContextTab />
                              </div>
                            </Show>
                          </Tabs.Content>
                        </Show>

                        <Show when={activeFileTab()} keyed>
                          {(tab) => <FileTabContent tab={tab} />}
                        </Show>
                      </Tabs>
                      <DragOverlay>
                        <Show when={store.activeDraggable} keyed>
                          {(tab) => {
                            const path = file.pathFromTab(tab)
                            return (
                              <div data-component="tabs-drag-preview">
                                <Show when={path}>{(p) => <FileVisual active path={p()} />}</Show>
                              </div>
                            )
                          }}
                        </Show>
                      </DragOverlay>
                    </DragDropProvider>
                  </div>
                </div>
                <div
                  id="file-tree-panel"
                  class="relative min-w-0 h-full shrink-0 overflow-hidden border-l border-border-weaker-base"
                  style={{ width: treeWidth() }}
                >
                  <div class="h-full flex flex-col overflow-hidden group/filetree">
                    <Tabs
                      variant="pill"
                      value={fileTreeTab()}
                      onChange={setFileTreeTabValue}
                      class="h-full"
                      data-scope="filetree"
                    >
                      <Tabs.List>
                        <Tabs.Trigger value="changes" class="flex-1" classes={{ button: "w-full" }}>
                          {props.reviewCount()}{" "}
                          {language.t(
                            props.reviewCount() === 1 ? "session.review.change.one" : "session.review.change.other",
                          )}
                        </Tabs.Trigger>
                        <Tabs.Trigger value="all" class="flex-1" classes={{ button: "w-full" }}>
                          {language.t("session.files.all")}
                        </Tabs.Trigger>
                      </Tabs.List>
                      <Tabs.Content value="changes" class="bg-background-stronger px-3 py-0">
                        <Switch>
                          <Match when={props.hasReview() || !props.diffsReady()}>
                            <Show
                              when={props.diffsReady()}
                              fallback={
                                <div class="px-2 py-2 text-12-regular text-text-weak">
                                  {language.t("common.loading")}
                                  {language.t("common.loading.ellipsis")}
                                </div>
                              }
                            >
                              <FileTree
                                path=""
                                class="pt-3"
                                allowed={diffFiles()}
                                kinds={kinds()}
                                draggable={false}
                                active={props.activeDiff}
                                onFileClick={(node) => props.focusReviewDiff(node.path)}
                              />
                            </Show>
                          </Match>
                          <Match when={true}>{empty(props.empty())}</Match>
                        </Switch>
                      </Tabs.Content>
                      <Tabs.Content value="all" class="bg-background-stronger px-3 py-0">
                        <Switch>
                          <Match when={nofiles()}>{empty(language.t("session.files.empty"))}</Match>
                          <Match when={true}>
                            <FileTree
                              path=""
                              class="pt-3"
                              modified={diffFiles()}
                              kinds={kinds()}
                              onFileClick={(node) => openTab(file.tab(node.path))}
                            />
                          </Match>
                        </Switch>
                      </Tabs.Content>
                    </Tabs>
                  </div>
                  <div onPointerDown={() => props.size.start()}>
                    <ResizeHandle
                      direction="horizontal"
                      edge="start"
                      size={view().sidePanel.explorer.width()}
                      min={200}
                      max={480}
                      onResize={(width) => {
                        props.size.touch()
                        view().sidePanel.explorer.resize(width)
                      }}
                    />
                  </div>
                </div>
              </div>
            </Tabs.Content>

            <Tabs.Content value="terminal" class="min-h-0 flex-1 overflow-hidden">
              <Show when={sidePanelTab() === "terminal"}>
                <Show
                  when={props.terminalPanel}
                  fallback={<div class="px-4 py-3 text-14-regular text-text-weak">{language.t("terminal.loading")}</div>}
                >
                  {(renderTerminal) => renderTerminal()()}
                </Show>
              </Show>
            </Tabs.Content>
          </Tabs>
        </div>
      </aside>
    </Show>
  )
}
