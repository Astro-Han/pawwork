import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
import { Tabs } from "@opencode-ai/ui/tabs"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { Mark } from "@opencode-ai/ui/logo"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import type { SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"
import { useDialog } from "@opencode-ai/ui/context/dialog"

import { SessionContextUsage } from "@/components/session-context-usage"
import { FileVisual, SessionContextTab, ShellTab, SortableShellTab, SortableTab } from "@/components/session"
import { SessionStatusPanel } from "@/components/session/session-status-panel"
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
import {
  isRightPanelTab,
  RIGHT_PANEL_TAB_META,
  RIGHT_PANEL_TAB_VALUES,
  type RightPanelShellIconName,
  type RightPanelTab,
  type ShellTabIcon,
} from "@/pages/session/right-panel-tabs"
import { useSessionLayout } from "@/pages/session/session-layout"

/** Converts right-panel state into the CSS width applied to the shell. */
export function formatRightPanelWidth(open: boolean, width: number): string {
  return open ? `${width}px` : "0px"
}

/** Creates a resize callback that marks user sizing before delegating width storage to layout state. */
export function makeRightPanelResizeHandler(
  size: { touch: () => void },
  layout: { rightPanel: { resize: (width: number) => void } },
): (width: number) => void {
  return (width) => {
    size.touch()
    layout.rightPanel.resize(width)
  }
}

/** Returns whether the Review inner tab row should expose the file-open shortcut. */
export function shouldShowReviewFileOpenButton(activeTab: string | undefined, hasSecondaryTabs: boolean): boolean {
  return hasSecondaryTabs || activeTab !== "review"
}

/** Returns shell tabs that can be reordered by the user. Status is pinned. */
export function sortableShellTabIds(tabs: readonly RightPanelTab[]): RightPanelTab[] {
  return tabs.filter((tab) => tab !== "status")
}

/** Names the file-opening transition that must activate Review before showing file-specific content. */
export function openReviewShellTab(sidePanel: { openTab: (tab: "review") => void }) {
  sidePanel.openTab("review")
}

/** Maps right-panel tab names to their shell icon components. */
function RightPanelShellIcon(props: { icon: ShellTabIcon; active?: boolean }) {
  return (
    <Switch>
      <Match when={props.icon.kind === "indicator"}>
        <SessionContextUsage variant="indicator" />
      </Match>
      <Match when={props.icon.kind === "icon" && props.icon.name === "status"}>
        <Icon name="status" size="small" class="text-text-weaker" />
      </Match>
      <Match when={props.icon.kind === "icon" && props.icon.name === "folder"}>
        <Icon name="folder" size="small" class="text-text-weaker" />
      </Match>
      <Match when={props.icon.kind === "icon" && props.icon.name === "review"}>
        <Icon name={props.active ? "review-active" : "review"} size="small" class="text-text-weaker" />
      </Match>
      <Match when={props.icon.kind === "icon" && props.icon.name === "terminal"}>
        <Icon name={props.active ? "terminal-active" : "terminal"} size="small" class="text-text-weaker" />
      </Match>
    </Switch>
  )
}

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
  const { sessionKey, tabs, view } = useSessionLayout()

  const isDesktop = createMediaQuery("(min-width: 768px)")

  const open = createMemo(() => isDesktop() && view().sidePanel.opened())
  const reviewTab = createMemo(() => isDesktop())
  const sidePanelTab = createMemo(() => view().sidePanel.tab())
  const panelWidth = createMemo(() => formatRightPanelWidth(open(), layout.rightPanel.width()))

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
  const shellTabs = createMemo(
    () =>
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
          <DragDropProvider
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
            onDragOver={handleShellDragOver}
            collisionDetector={closestCenter}
          >
            <DragDropSensors />
            <ConstrainDragYAxis />
            <Tabs
              variant="sidepanel"
              value={sidePanelTab()}
              onChange={setSidePanelTabValue}
              class="h-full flex flex-col"
              data-scope="right-panel"
            >
              <Tabs.List class="h-11 shrink-0 px-2 py-0 border-b border-border-weaker-base gap-1 items-center">
                <SortableProvider ids={sortableShellTabIds(view().sidePanel.openTabs())}>
                  <For each={shellTabs()}>
                    {(tab) => (
                      <Show
                        when={tab.value !== "status"}
                        fallback={
                          <ShellTab
                            value={tab.value}
                            label={tab.label}
                            closable={tab.closable}
                            onClose={view().sidePanel.closeTab}
                          >
                            <RightPanelShellIcon icon={tab.icon} active={activeTab() === tab.value} />
                            <span>{tab.label}</span>
                          </ShellTab>
                        }
                      >
                        <SortableShellTab
                          value={tab.value}
                          label={tab.label}
                          closable={tab.closable}
                          onClose={view().sidePanel.closeTab}
                        >
                          <RightPanelShellIcon icon={tab.icon} active={activeTab() === tab.value} />
                          <span>{tab.label}</span>
                        </SortableShellTab>
                      </Show>
                    )}
                  </For>
                </SortableProvider>
                <div class="flex-1" />
                {/* 40px right-gutter reserve — matches docs/design/src/rightpanel.jsx,
                  gives the tab row breathing room against the panel edge. */}
                <DropdownMenu gutter={4} placement="bottom-end">
                  <DropdownMenu.Trigger
                    as={IconButton}
                    icon="plus-small"
                    variant="ghost"
                    class="w-8 h-7 shrink-0"
                    aria-label={language.t("session.panel.addTab")}
                  />
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content>
                      <DropdownMenu.Item onSelect={() => openFilePicker(showAllFiles)}>
                        <Icon name="open-file" size="small" />
                        <DropdownMenu.ItemLabel>{language.t("command.file.open")}</DropdownMenu.ItemLabel>
                        <span class="ml-auto text-12-regular text-text-weaker">{command.keybind("file.open")}</span>
                      </DropdownMenu.Item>
                      <Show when={closableMissingTabs().length > 0}>
                        <DropdownMenu.Separator />
                        <For each={closableMissingTabs()}>
                          {(tab) => (
                            <DropdownMenu.Item onSelect={() => view().sidePanel.openTab(tab.value)}>
                              <Icon name={tab.iconName} size="small" />
                              <DropdownMenu.ItemLabel>{tab.label}</DropdownMenu.ItemLabel>
                              <Show when={tab.keybind}>
                                {(keybind) => (
                                  <span class="ml-auto text-12-regular text-text-weaker">{keybind()}</span>
                                )}
                              </Show>
                            </DropdownMenu.Item>
                          )}
                        </For>
                      </Show>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu>
              </Tabs.List>

            <Tabs.Content value="status" class="min-h-0 flex-1 overflow-hidden">
              <SessionStatusPanel shown={() => open() && sidePanelTab() === "status"} />
            </Tabs.Content>

            <Tabs.Content value="files" class="min-h-0 flex-1 overflow-hidden">
              <FilesTab files={props.files()} />
            </Tabs.Content>

            <Tabs.Content value="review" class="min-h-0 flex-1 overflow-hidden">
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
                              <Show when={shouldShowReviewFileOpenButton(activeTab(), false)}>
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
                              </Show>
                            }
                          >
                            <Tabs.List
                              ref={(el: HTMLDivElement) => {
                                const stop = createFileTabListSync({ el })
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
            </Tabs.Content>

              <Tabs.Content value="terminal" class="min-h-0 flex-1 overflow-hidden">
                <Show when={sidePanelTab() === "terminal"}>
                  <Show
                    when={props.terminalPanel}
                    fallback={
                      <div class="px-4 py-3 text-14-regular text-text-weak">{language.t("terminal.loading")}</div>
                    }
                  >
                    {(renderTerminal) => renderTerminal()()}
                  </Show>
                </Show>
              </Tabs.Content>

              <Tabs.Content value="context" class="min-h-0 flex-1 overflow-hidden">
                <SessionContextTab />
              </Tabs.Content>
            </Tabs>
          </DragDropProvider>
        </div>
      </aside>
    </Show>
  )
}
