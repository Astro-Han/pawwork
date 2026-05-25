import { For, Show, onCleanup, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { DragDropProvider, DragDropSensors, DragOverlay, SortableProvider, closestCenter } from "@thisbeyond/solid-dnd"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { Tabs } from "@opencode-ai/ui/tabs"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { ConstrainDragYAxis, getDraggableId } from "@/utils/solid-dnd"

import { FileVisual, SortableTab } from "@/components/session"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { createFileTabListSync } from "@/pages/session/file-tab-scroll"
import { FileTabContent } from "@/pages/session/file-tabs"
import { getTabReorderIndex, shouldShowReviewFileOpenButton } from "@/pages/session/helpers"

/**
 * Review panel inner body: nested file-review Tabs, DragDropProvider for file tab
 * reordering, and per-tab content switching (review / empty / file-tab-content).
 */
export function RightPanelReviewBody(props: {
  canReview: () => boolean
  hasReview: () => boolean
  reviewCount: () => number
  reviewPanel: () => JSX.Element
  activeTab: () => string | undefined
  activeFileTab: () => string | undefined
  openedTabs: () => string[]
  showSecondaryReviewTabs: () => boolean
  openTab: (tab: string) => void
  openFilePicker: (onOpenFile?: () => void) => void
  showAllFiles: () => void
  tabs: {
    all: () => string[]
    close: (tab: string) => void
    move: (tab: string, index: number) => void
  }
  pathFromTab: (tab: string) => string | undefined
  reviewTab: () => boolean
}) {
  const language = useLanguage()
  const command = useCommand()
  const [store, setStore] = createStore({
    activeDraggable: undefined as string | undefined,
  })

  const handleDragStart = (event: unknown) => {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeDraggable", id)
  }

  const handleDragOver = (event: DragEvent) => {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return

    const currentTabs = props.tabs.all()
    const toIndex = getTabReorderIndex(currentTabs, draggable.id.toString(), droppable.id.toString())
    if (toIndex === undefined) return
    props.tabs.move(draggable.id.toString(), toIndex)
  }

  const handleDragEnd = () => {
    setStore("activeDraggable", undefined)
  }

  return (
    <div class="relative min-w-0 h-full flex-1 overflow-hidden bg-bg-base">
      <div class="size-full min-w-0 h-full bg-bg-base">
        <DragDropProvider
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragOver={handleDragOver}
          collisionDetector={closestCenter}
        >
          <DragDropSensors />
          <ConstrainDragYAxis />
          <Tabs value={props.activeTab()} onChange={props.openTab}>
            <div class="sticky top-0 shrink-0 flex">
              <Show
                when={props.showSecondaryReviewTabs()}
                fallback={
                  <Show when={shouldShowReviewFileOpenButton(props.activeTab(), false)}>
                    <div class="w-full bg-bg-base flex items-center justify-end px-3 py-1.5">
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
                          onClick={() => props.openFilePicker(props.showAllFiles)}
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
                  <Show when={props.reviewTab() && props.canReview()}>
                    <Tabs.Trigger value="review">
                      <div class="flex items-center gap-1.5">
                        <div>{language.t("session.tab.review")}</div>
                        <Show when={props.hasReview()}>
                          <div>{props.reviewCount()}</div>
                        </Show>
                      </div>
                    </Tabs.Trigger>
                  </Show>
                  <SortableProvider ids={props.openedTabs()}>
                    <For each={props.openedTabs()}>
                      {(tab) => <SortableTab tab={tab} onTabClose={props.tabs.close} />}
                    </For>
                  </SortableProvider>
                  <div class="bg-bg-base h-full shrink-0 sticky right-0 z-10 flex items-center justify-center pr-3">
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
                        onClick={() => props.openFilePicker(props.showAllFiles)}
                        aria-label={language.t("command.file.open")}
                      />
                    </TooltipKeybind>
                  </div>
                </Tabs.List>
              </Show>
            </div>

            <Show when={props.reviewTab() && props.canReview()}>
              <Tabs.Content value="review" class="flex flex-col h-full overflow-hidden contain-strict">
                <Show when={props.activeTab() === "review"}>{props.reviewPanel()}</Show>
              </Tabs.Content>
            </Show>

            <Tabs.Content value="empty" class="flex flex-col h-full overflow-hidden contain-strict">
              <Show when={props.activeTab() === "empty"}>
                <div class="relative pt-2 flex-1 min-h-0 overflow-hidden">
                  <div class="h-full px-6 pb-42 -mt-4 flex flex-col items-center justify-center text-center">
                    <div class="text-body text-fg-weak max-w-56">{language.t("session.files.selectToOpen")}</div>
                  </div>
                </div>
              </Show>
            </Tabs.Content>

            <Show when={props.activeFileTab()} keyed>
              {(tab) => <FileTabContent tab={tab} />}
            </Show>
          </Tabs>
          <DragOverlay>
            <Show when={store.activeDraggable} keyed>
              {(tab) => {
                const path = props.pathFromTab(tab)
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
  )
}
