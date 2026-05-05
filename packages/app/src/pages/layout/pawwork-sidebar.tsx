import type { Session } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { ContextMenu } from "@opencode-ai/ui/context-menu"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { createEffect, createMemo, For, Show, type Accessor, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import { getRelativeTime } from "@/utils/time"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogRenameSession } from "@/components/dialog-rename-session"
import { buildPawworkSessionSections, type PawworkSortMode } from "./pawwork-session-nav"
import { buildSessionMenuActions, type SessionMenuAction } from "./session-menu-actions"
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
  sessions: Accessor<PawworkSidebarSession[]>
  sessionWindow: Accessor<{ canShowMore: boolean; capReached: boolean; loading: boolean }>
  showProjectEmptyState: boolean
  activeSessionID?: Accessor<string | undefined>
  pinnedIDs: Accessor<string[]>
  sortMode: Accessor<PawworkSortMode>
  setScrollContainerRef: (el: HTMLDivElement | undefined) => void
  prefetchSession: (session: Session, priority?: "high" | "low") => void
  hrefForSession?: (session: Session) => string
  onOpenSession: (session: Session) => void
  onRenameSession: (session: Session, next: string) => Promise<void>
  onTogglePinnedSession: (sessionID: string) => void
  exportSessionAvailable: Accessor<boolean>
  onExportSession: (session: Session) => Promise<void>
  onDeleteSession: (session: Session) => void
  onSetSortMode: (mode: PawworkSortMode) => void
  onShowMore: () => void
  onSearchOlderSessions: () => void
  onNew: () => void
  onSearch: () => void
  onOpenProject: () => void
  onOpenSettings: () => void
  settingsLabel: Accessor<string>
  settingsKeybind: Accessor<string | undefined>
}): JSX.Element => {
  const language = useLanguage()
  const dialog = useDialog()
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
    const menuLabels = () => ({
      pin: language.t("sidebar.pawwork.pinSession"),
      unpin: language.t("sidebar.pawwork.unpinSession"),
      rename: language.t("common.rename"),
      export: language.t("session.export.action.export"),
      delete: language.t("common.delete"),
    })
    const menuActions = (target: Session, onRenameSession: (session: Session) => void) =>
      buildSessionMenuActions({
        session: target,
        pinned: props.pinnedIDs().includes(target.id),
        exportAvailable: props.exportSessionAvailable(),
        labels: menuLabels(),
        onTogglePinnedSession: props.onTogglePinnedSession,
        onRenameSession,
        onExportSession: props.onExportSession,
        onDeleteSession: props.onDeleteSession,
      })
    const renderDropdownActions = (actions: SessionMenuAction[]) => (
      <>
        <For each={actions}>
          {(action) => (
            <>
              <Show when={action.separatorBefore}>
                <DropdownMenu.Separator />
              </Show>
              <DropdownMenu.Item onSelect={() => void action.run()}>
                <DropdownMenu.ItemLabel>{action.label}</DropdownMenu.ItemLabel>
              </DropdownMenu.Item>
            </>
          )}
        </For>
      </>
    )
    const renderContextActions = (actions: SessionMenuAction[]) => (
      <>
        <For each={actions}>
          {(action) => (
            <>
              <Show when={action.separatorBefore}>
                <ContextMenu.Separator />
              </Show>
              <ContextMenu.Item onSelect={() => void action.run()}>
                <ContextMenu.ItemLabel>{action.label}</ContextMenu.ItemLabel>
              </ContextMenu.Item>
            </>
          )}
        </For>
      </>
    )

    return (
      <ContextMenu>
        <ContextMenu.Trigger as="div" class="flex flex-col gap-1">
          <SessionItem
            session={session}
            list={navList()}
            navList={navList}
            slug={entry.item.slug}
            showChild
            prefetchSession={props.prefetchSession}
            hrefForSession={props.hrefForSession}
            onOpenSession={props.onOpenSession}
            pinned={() => isPinned()}
            timeText={() =>
              entry.item.created > 0
                ? getRelativeTime(new Date(entry.item.created).toISOString(), language.t)
                : undefined
            }
            titleContent={({ title }) => (
              <span
                class="text-13-regular text-fg-base [.active_&]:text-fg-strong min-w-0 flex-1 truncate"
                onDblClick={(e: MouseEvent) => {
                  e.preventDefault()
                  e.stopPropagation()
                  dialog.show(() => (
                    <DialogRenameSession
                      name={session.title ?? ""}
                      onConfirm={(next) => void props.onRenameSession(session, next)}
                    />
                  ))
                }}
              >
                {title()}
              </span>
            )}
            actionSlot={(rowSession) => (
              <DropdownMenu>
                <DropdownMenu.Trigger
                  as={IconButton}
                  icon="dot-grid"
                  variant="ghost"

                  class="rounded-md"
                  data-action="session-row-menu"
                  aria-label={language.t("common.moreOptions")}
                  onClick={(event: MouseEvent) => {
                    event.preventDefault()
                    event.stopPropagation()
                  }}
                />
                <DropdownMenu.Portal>
                  <DropdownMenu.Content>
                    {renderDropdownActions(
                      menuActions(rowSession, () => {
                        dialog.show(() => (
                          <DialogRenameSession
                            name={rowSession.title ?? ""}
                            onConfirm={(next) => void props.onRenameSession(rowSession, next)}
                          />
                        ))
                      }),
                    )}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu>
            )}
          />
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content>
            {renderContextActions(
              menuActions(session, () => {
                dialog.show(() => (
                  <DialogRenameSession
                    name={session.title ?? ""}
                    onConfirm={(next) => void props.onRenameSession(session, next)}
                  />
                ))
              }),
            )}
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

  const tooltipPlacement = () => "right" as const
  const sortAriaLabel = () =>
    props.sortMode() === "time" ? language.t("sidebar.pawwork.sort.byProject") : language.t("sidebar.pawwork.sort.byTime")

  return (
    <section
      data-component="pawwork-sidebar"
      data-sidebar-scope={props.scope ?? "main"}
      class="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-bg-cream"
    >
      <div class="shrink-0 px-3 pt-3">
        <div class="flex flex-col gap-1">
          <button
            type="button"
            data-action="pawwork-session-new"
            onClick={props.onNew}
            class="w-full flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-md hover:bg-surface-raised focus-visible:bg-surface-raised transition-colors text-left focus:outline-none"
          >
            <span class="shrink-0 w-4 h-4 flex items-center">
              <Icon name="new-session" size="small" class="text-icon-base" />
            </span>
            <span class="text-13-medium text-fg-base min-w-0 flex-1 truncate">{language.t("command.session.new")}</span>
          </button>
          <button
            type="button"
            data-action="pawwork-session-search"
            onClick={props.onSearch}
            class="w-full flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-md hover:bg-surface-raised focus-visible:bg-surface-raised transition-colors text-left focus:outline-none"
          >
            <span class="shrink-0 w-4 h-4 flex items-center">
              <Icon name="magnifying-glass" size="small" class="text-icon-base" />
            </span>
            <span class="text-13-medium text-fg-base min-w-0 flex-1 truncate">{language.t("sidebar.pawwork.search")}</span>
          </button>
        </div>
      </div>

      <Show
        when={!props.showProjectEmptyState}
        fallback={
          <div class="flex flex-1 items-center px-5">
            <div class="flex w-full flex-col gap-3">
              <div class="text-13-medium text-fg-strong">{language.t("sidebar.empty.title")}</div>
              <p class="text-13-regular text-fg-weak">{language.t("sidebar.pawwork.empty.description")}</p>
              <Button data-action="pawwork-open-project" onClick={props.onOpenProject}>
                {language.t("command.project.open")}
              </Button>
            </div>
          </div>
        }
      >
        <div
          ref={(el) => {
            scrollEl = el
            props.setScrollContainerRef(el)
          }}
          data-component="pawwork-session-scroll"
          class="flex-1 min-h-0 overflow-y-auto px-3 pb-3"
        >
          <Show when={props.sessions().length > 0}>
            <nav class="flex flex-col gap-1">
              <Show when={pinnedRows().length > 0}>
                <section data-component="pawwork-sidebar-pinned" class="flex flex-col gap-0.5">
                  <div class="px-2 pt-3 pb-2 text-12-regular text-fg-weak">{language.t("sidebar.pawwork.pinned")}</div>
                  <For each={pinnedRows()}>{(entry) => renderSessionItem(entry)}</For>
                </section>
              </Show>
              <Show when={rows().length > 0 || groupedRows().length > 0}>
                <div class="mt-3 flex items-center justify-between pr-2 pl-2 pb-2">
                  <span class="text-12-regular text-fg-weak">{language.t("sidebar.pawwork.all")}</span>
                  <button
                    type="button"
                    data-action="pawwork-sort-mode"
                    data-mode={props.sortMode()}
                    aria-label={sortAriaLabel()}
                    title={sortAriaLabel()}
                    onClick={() => props.onSetSortMode(props.sortMode() === "time" ? "project" : "time")}
                    classList={{
                      "inline-flex items-center justify-center size-5 rounded-md transition-colors": true,
                      "hover:bg-surface-raised": true,
                      "text-fg-strong": props.sortMode() === "project",
                      "text-fg-weak": props.sortMode() !== "project",
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
                      <div data-component="pawwork-group-header" class="px-2 pt-3 pb-2 text-12-regular text-fg-weak">
                        {group.label}
                      </div>
                      <For each={group.items}>{(item) => renderSessionItem({ item })}</For>
                    </section>
                  )}
                </For>
              </Show>
              <Show when={props.sessionWindow().canShowMore}>
                <button
                  type="button"
                  data-action="pawwork-session-show-more"
                  disabled={props.sessionWindow().loading}
                  onClick={props.onShowMore}
                  class="mt-2 w-full rounded-md px-2 py-1.5 text-left text-13-regular text-fg-weak transition-colors hover:bg-surface-raised hover:text-fg-base focus:outline-none focus-visible:bg-surface-raised disabled:opacity-50"
                >
                  {props.sessionWindow().loading ? language.t("common.loading") : language.t("common.showMore")}
                </button>
              </Show>
              <Show when={props.sessionWindow().capReached}>
                <button
                  type="button"
                  data-action="pawwork-session-search-history"
                  onClick={props.onSearchOlderSessions}
                  class="mt-2 w-full rounded-md px-2 py-1.5 text-left text-13-regular text-fg-weak transition-colors hover:bg-surface-raised hover:text-fg-base focus:outline-none focus-visible:bg-surface-raised"
                >
                  {language.t("sidebar.pawwork.searchHistory")}
                </button>
              </Show>
            </nav>
          </Show>
        </div>
      </Show>

      <div
        data-component="pawwork-sidebar-footer"
        class="shrink-0 border-t border-border-weaker px-3 py-2"
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
            class="w-full flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-md hover:bg-surface-raised focus-visible:bg-surface-raised transition-colors text-left focus:outline-none"
          >
            <span class="shrink-0 w-4 h-4 flex items-center">
              <Icon name="settings-gear" size="small" class="text-icon-base" />
            </span>
            <span class="text-13-medium text-fg-base min-w-0 flex-1 truncate">{props.settingsLabel()}</span>
          </button>
        </TooltipKeybind>
      </div>
    </section>
  )
}
