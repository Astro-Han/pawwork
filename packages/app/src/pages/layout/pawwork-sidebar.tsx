import type { Session } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { ContextMenu } from "@opencode-ai/ui/context-menu"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { createEffect, createMemo, createSignal, For, Show, type Accessor, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import { getRelativeTime } from "@/utils/time"
import { createInlineEditorController } from "./inline-editor"
import { buildPawworkSessionSections, type PawworkSortMode } from "./pawwork-session-nav"
import { SessionItem } from "./sidebar-items"
import "./sidebar.css"

export type PawworkSidebarSession = {
  session: Session
  slug: string
  projectLabel: string
  created: number
}

const FilterIcon = (props: { size?: number }) => {
  const size = props.size ?? 14
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M2.5 5h15M5 10h10M7.5 15h5" stroke="currentColor" stroke-linecap="square" />
    </svg>
  )
}

export const PawworkSidebar = (props: {
  scope?: "main" | "peek"
  mobile?: boolean
  sessions: Accessor<PawworkSidebarSession[]>
  showProjectEmptyState: boolean
  activeSessionID?: Accessor<string | undefined>
  pinnedIDs: Accessor<string[]>
  sortMode: Accessor<PawworkSortMode>
  sidebarExpanded: Accessor<boolean>
  setScrollContainerRef: (el: HTMLDivElement | undefined, mobile?: boolean) => void
  clearHoverProjectSoon: () => void
  prefetchSession: (session: Session, priority?: "high" | "low") => void
  onRenameSession: (session: Session, next: string) => Promise<void>
  onTogglePinnedSession: (sessionID: string) => void
  exportSessionAvailable: Accessor<boolean>
  onExportSession: (session: Session) => Promise<void>
  onDeleteSession: (session: Session) => void
  onSetSortMode: (mode: PawworkSortMode) => void
  onNew: () => void
  onSearch: () => void
  onOpenProject: () => void
  onOpenSettings: () => void
  settingsLabel: Accessor<string>
  settingsKeybind: Accessor<string | undefined>
}): JSX.Element => {
  const language = useLanguage()
  const editor = createInlineEditorController()
  const [pendingRenameID, setPendingRenameID] = createSignal<string>()
  const navList = createMemo(() => props.sessions().map((item) => item.session))
  let scrollEl: HTMLDivElement | undefined
  const byID = createMemo(() => new Map(props.sessions().map((item) => [item.session.id, item] as const)))
  const sections = createMemo(() =>
    buildPawworkSessionSections({
      sessions: props.sessions().map((item) => ({
        id: item.session.id,
        title: item.session.title ?? "",
        directory: item.session.directory,
        projectLabel: item.projectLabel,
        created: item.created,
      })),
      pinnedIDs: props.pinnedIDs(),
      sortMode: props.sortMode(),
      currentSessionID: props.activeSessionID?.(),
    }),
  )
  const rows = createMemo(() =>
    sections()
      .recent.map((item) => ({ item: byID().get(item.id) }))
      .filter((entry): entry is { item: PawworkSidebarSession } => !!entry.item),
  )
  const pinnedRows = createMemo(() =>
    sections()
      .pinned.map((item) => ({ item: byID().get(item.id) }))
      .filter((entry): entry is { item: PawworkSidebarSession } => !!entry.item),
  )
  const groupedRows = createMemo(() =>
    sections().groups.map((group) => ({
      label: group.label,
      items: group.items
        .map((item) => byID().get(item.id))
        .filter((item): item is PawworkSidebarSession => !!item),
    })),
  )

  const renderSessionItem = (entry: { item: PawworkSidebarSession }) => {
    const session = entry.item.session
    const isPinned = createMemo(() => props.pinnedIDs().includes(session.id))
    const pinLabel = () =>
      isPinned() ? language.t("sidebar.pawwork.unpinSession") : language.t("sidebar.pawwork.pinSession")

    return (
      <ContextMenu>
        <ContextMenu.Trigger as="div" class="flex flex-col gap-1">
          <SessionItem
            session={session}
            list={navList()}
            navList={navList}
            slug={entry.item.slug}
            mobile={props.mobile}
            showChild
            sidebarExpanded={props.sidebarExpanded}
            clearHoverProjectSoon={props.clearHoverProjectSoon}
            prefetchSession={props.prefetchSession}
            pinned={() => isPinned()}
            timeText={() =>
              entry.item.created > 0
                ? getRelativeTime(new Date(entry.item.created).toISOString(), language.t)
                : undefined
            }
            titleContent={({ session: rowSession, title }) => (
              <editor.InlineEditor
                id={`pawwork-session:${rowSession.id}`}
                value={title}
                onSave={(next) => {
                  void props.onRenameSession(rowSession, next)
                }}
                class="text-13-regular text-text-base [.active_&]:text-text-strong min-w-0 flex-1 truncate"
                displayClass="text-13-regular text-text-base [.active_&]:text-text-strong min-w-0 flex-1 truncate"
              />
            )}
            actionSlot={(rowSession) => (
              <DropdownMenu>
                <DropdownMenu.Trigger
                  as={IconButton}
                  icon="dot-grid"
                  variant="ghost"
                  size="small"
                  class="rounded-md"
                  data-action="session-row-menu"
                  aria-label={language.t("common.moreOptions")}
                  onClick={(event: MouseEvent) => {
                    event.preventDefault()
                    event.stopPropagation()
                  }}
                />
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    onCloseAutoFocus={(event) => {
                      if (pendingRenameID() !== rowSession.id) return
                      event.preventDefault()
                      setPendingRenameID(undefined)
                      requestAnimationFrame(() => {
                        editor.openEditor(`pawwork-session:${rowSession.id}`, rowSession.title ?? "")
                      })
                    }}
                  >
                    <DropdownMenu.Item onSelect={() => props.onTogglePinnedSession(rowSession.id)}>
                      <DropdownMenu.ItemLabel>{pinLabel()}</DropdownMenu.ItemLabel>
                    </DropdownMenu.Item>
                    <DropdownMenu.Item
                      onSelect={() => {
                        setPendingRenameID(rowSession.id)
                      }}
                    >
                      <DropdownMenu.ItemLabel>{language.t("common.rename")}</DropdownMenu.ItemLabel>
                    </DropdownMenu.Item>
                    <Show when={props.exportSessionAvailable()}>
                      <DropdownMenu.Item onSelect={() => void props.onExportSession(rowSession)}>
                        <DropdownMenu.ItemLabel>
                          {language.t("session.export.action.export")}
                        </DropdownMenu.ItemLabel>
                      </DropdownMenu.Item>
                    </Show>
                    <DropdownMenu.Separator />
                    <DropdownMenu.Item onSelect={() => props.onDeleteSession(rowSession)}>
                      <DropdownMenu.ItemLabel>{language.t("common.delete")}</DropdownMenu.ItemLabel>
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu>
            )}
          />
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content>
            <ContextMenu.Item onSelect={() => props.onTogglePinnedSession(session.id)}>
              <ContextMenu.ItemLabel>{pinLabel()}</ContextMenu.ItemLabel>
            </ContextMenu.Item>
            <ContextMenu.Item
              onSelect={() => {
                editor.openEditor(`pawwork-session:${session.id}`, session.title ?? "")
              }}
            >
              <ContextMenu.ItemLabel>{language.t("common.rename")}</ContextMenu.ItemLabel>
            </ContextMenu.Item>
            <Show when={props.exportSessionAvailable()}>
              <ContextMenu.Item onSelect={() => void props.onExportSession(session)}>
                <ContextMenu.ItemLabel>{language.t("session.export.action.export")}</ContextMenu.ItemLabel>
              </ContextMenu.Item>
            </Show>
            <ContextMenu.Separator />
            <ContextMenu.Item onSelect={() => props.onDeleteSession(session)}>
              <ContextMenu.ItemLabel>{language.t("common.delete")}</ContextMenu.ItemLabel>
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu>
    )
  }

  // Only react to coarse signals that warrant re-centering the active row:
  // selection change, sort mode flip, list size change (initial load / add / delete),
  // or pin/unpin (which moves the active row between sections).
  // Tracking rows()/pinnedRows()/groupedRows() would re-fire on every session field
  // update (e.g. time.updated bump on submit), pulling the sidebar back to top.
  const sessionCount = createMemo(() => props.sessions().length)
  const pinnedSignature = createMemo(() => props.pinnedIDs().join("\0"))
  createEffect(() => {
    const activeSessionID = props.activeSessionID?.()
    props.sortMode()
    sessionCount()
    pinnedSignature()
    const el = scrollEl
    if (!activeSessionID || !el) return

    requestAnimationFrame(() => {
      const row = el.querySelector<HTMLElement>(`[data-session-id="${activeSessionID}"]`)
      if (!row) return
      row.scrollIntoView({ block: "nearest" })
    })
  })

  const tooltipPlacement = () => (props.mobile ? "bottom" : "right")
  const sortAriaLabel = () =>
    props.sortMode() === "time" ? language.t("sidebar.pawwork.sort.byProject") : language.t("sidebar.pawwork.sort.byTime")

  return (
    <section
      data-component="pawwork-sidebar"
      data-sidebar-scope={props.scope ?? "main"}
      class="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background-weak"
    >
      <div class="shrink-0 px-3 pt-3">
        <div class="flex flex-col gap-1">
          <button
            type="button"
            data-action="pawwork-session-new"
            onClick={props.onNew}
            class="w-full flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-md hover:bg-surface-raised-base-hover focus-visible:bg-surface-raised-base-hover transition-colors text-left focus:outline-none"
          >
            <span class="shrink-0 w-4 h-4 flex items-center">
              <Icon name="new-session" size="small" class="text-icon-base" />
            </span>
            <span class="text-13-medium text-text-base min-w-0 flex-1 truncate">{language.t("command.session.new")}</span>
          </button>
          <button
            type="button"
            data-action="pawwork-session-search"
            onClick={props.onSearch}
            class="w-full flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-md hover:bg-surface-raised-base-hover focus-visible:bg-surface-raised-base-hover transition-colors text-left focus:outline-none"
          >
            <span class="shrink-0 w-4 h-4 flex items-center">
              <Icon name="magnifying-glass" size="small" class="text-icon-base" />
            </span>
            <span class="text-13-medium text-text-base min-w-0 flex-1 truncate">{language.t("sidebar.pawwork.search")}</span>
          </button>
        </div>
      </div>

      <Show
        when={!props.showProjectEmptyState}
        fallback={
          <div class="flex flex-1 items-center px-5">
            <div class="flex w-full flex-col gap-3">
              <div class="text-13-medium text-text-strong">{language.t("sidebar.empty.title")}</div>
              <p class="text-13-regular text-text-weak">{language.t("sidebar.pawwork.empty.description")}</p>
              <Button data-action="pawwork-open-project" size="large" onClick={props.onOpenProject}>
                {language.t("command.project.open")}
              </Button>
            </div>
          </div>
        }
      >
        <div
          ref={(el) => {
            scrollEl = el
            props.setScrollContainerRef(el, props.mobile)
          }}
          data-component="pawwork-session-scroll"
          class="flex-1 min-h-0 overflow-y-auto px-3 pb-3"
        >
          <Show
            when={props.sessions().length > 0}
            fallback={<div class="px-2 text-13-regular text-text-weak">{language.t("sidebar.pawwork.empty.sessions")}</div>}
          >
            <nav class="flex flex-col gap-1">
              <Show when={pinnedRows().length > 0}>
                <section data-component="pawwork-sidebar-pinned" class="flex flex-col gap-0.5">
                  <div class="px-2 pt-3 pb-2 text-12-regular text-text-weak">{language.t("sidebar.pawwork.pinned")}</div>
                  <For each={pinnedRows()}>{(entry) => renderSessionItem(entry)}</For>
                </section>
              </Show>
              <Show when={rows().length > 0 || groupedRows().length > 0}>
                <div class="mt-3 flex items-center justify-between pr-2 pl-2 pb-2">
                  <span class="text-12-regular text-text-weak">{language.t("sidebar.pawwork.all")}</span>
                  <button
                    type="button"
                    data-action="pawwork-sort-mode"
                    data-mode={props.sortMode()}
                    aria-label={sortAriaLabel()}
                    title={sortAriaLabel()}
                    onClick={() => props.onSetSortMode(props.sortMode() === "time" ? "project" : "time")}
                    classList={{
                      "inline-flex items-center justify-center size-5 rounded-md transition-colors": true,
                      "hover:bg-surface-raised-base-hover": true,
                      "text-text-strong": props.sortMode() === "project",
                      "text-text-weak": props.sortMode() !== "project",
                    }}
                  >
                    <FilterIcon size={14} />
                  </button>
                </div>
              </Show>
              <Show when={props.sortMode() === "time"}>
                <div class="flex flex-col gap-0.5">
                  <For each={rows()}>{(entry) => renderSessionItem(entry)}</For>
                </div>
              </Show>
              <Show when={props.sortMode() === "project"}>
                <For each={groupedRows()}>
                  {(group) => (
                    <section class="flex flex-col gap-0.5">
                      <div data-component="pawwork-group-header" class="px-2 pt-3 pb-2 text-12-regular text-text-weak">
                        {group.label}
                      </div>
                      <For each={group.items}>{(item) => renderSessionItem({ item })}</For>
                    </section>
                  )}
                </For>
              </Show>
            </nav>
          </Show>
        </div>
      </Show>

      <div
        data-component="pawwork-sidebar-footer"
        class="shrink-0 border-t border-border-weaker-base px-3 py-2"
      >
        <TooltipKeybind
          placement={tooltipPlacement()}
          title={props.settingsLabel()}
          keybind={props.settingsKeybind() ?? ""}
        >
          <button
            type="button"
            data-action="pawwork-open-settings"
            onClick={props.onOpenSettings}
            aria-label={props.settingsLabel()}
            class="w-full flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-md hover:bg-surface-raised-base-hover focus-visible:bg-surface-raised-base-hover transition-colors text-left focus:outline-none"
          >
            <span class="shrink-0 w-4 h-4 flex items-center">
              <Icon name="settings-gear" size="small" class="text-icon-base" />
            </span>
            <span class="text-13-medium text-text-base min-w-0 flex-1 truncate">{props.settingsLabel()}</span>
          </button>
        </TooltipKeybind>
      </div>
    </section>
  )
}
