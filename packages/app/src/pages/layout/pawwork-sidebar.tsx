import type { Session } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { ContextMenu } from "@opencode-ai/ui/context-menu"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { createEffect, createMemo, For, Show, type Accessor, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import { getRelativeTime } from "@/utils/time"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
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

export const PawworkSidebar = (props: {
  scope?: "main" | "peek"
  sessions: Accessor<PawworkSidebarSession[]>
  sessionWindow: Accessor<{ canShowMore: boolean; capReached: boolean; loading: boolean }>
  showProjectEmptyState: boolean
  activeSessionID?: Accessor<string | undefined>
  pinnedIDs: Accessor<string[]>
  sortMode: Accessor<PawworkSortMode>
  collapsedProjects: Accessor<Record<string, boolean>>
  onToggleProjectCollapsed: (label: string) => void
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
  newSessionKeybind: Accessor<string | undefined>
  searchKeybind: Accessor<string | undefined>
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

  const openRenameDialog = (target: Session) => {
    dialog.show(() => (
      <DialogRenameSession
        name={target.title ?? ""}
        onConfirm={(next) => props.onRenameSession(target, next)}
      />
    ))
  }

  const renderSessionItem = (entry: { item: PawworkSidebarSession }) => {
    const session = entry.item.session
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
                <Icon name={action.icon} class="text-icon-weak" />
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
                <Icon name={action.icon} class="text-icon-weak" />
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
            timeText={() =>
              entry.item.created > 0
                ? getRelativeTime(new Date(entry.item.created).toISOString(), language.t)
                : undefined
            }
            titleContent={({ title }) => (
              <span
                class="text-13-regular text-fg-base [.active_&]:text-fg-strong [.active_&]:font-medium min-w-0 flex-1 truncate"
                onDblClick={(e: MouseEvent) => {
                  e.preventDefault()
                  e.stopPropagation()
                  openRenameDialog(session)
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
                      menuActions(rowSession, () => openRenameDialog(rowSession)),
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
              menuActions(session, () => openRenameDialog(session)),
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

  return (
    <section
      data-component="pawwork-sidebar"
      data-sidebar-scope={props.scope ?? "main"}
      class="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-sidebar"
    >
      {/* L37 reserves a top "traffic" segment for slice 17 to fill with the macOS
         traffic-light cluster + collapse control. The OS already paints traffic
         lights on its window chrome, so reserving a second 32px band here would
         double the empty space at the top. The placeholder will return when
         slice 17 hides the OS chrome and moves the controls into the sidebar. */}
      <div data-component="pawwork-side-top" class="shrink-0 px-3 pt-3">
        <div class="flex flex-col gap-1">
          <TooltipKeybind
            placement="right"
            title={language.t("command.session.new")}
            keybind={props.newSessionKeybind() ?? ""}
          >
            <button
              type="button"
              data-action="pawwork-session-new"
              onClick={props.onNew}
              class="w-full h-[32px] flex items-center gap-2 px-2.5 rounded-md hover:bg-row-hover-overlay focus-visible:bg-row-hover-overlay transition-colors text-left focus:outline-none"
            >
              <span class="shrink-0 w-4 h-4 flex items-center">
                <Icon name="new-session" class="text-icon-base" />
              </span>
              <span class="text-13-medium text-fg-base min-w-0 flex-1 truncate">{language.t("command.session.new")}</span>
            </button>
          </TooltipKeybind>
          <TooltipKeybind
            placement="right"
            title={language.t("sidebar.pawwork.search")}
            keybind={props.searchKeybind() ?? ""}
          >
            <button
              type="button"
              data-action="pawwork-session-search"
              onClick={props.onSearch}
              class="w-full h-[32px] flex items-center gap-2 px-2.5 rounded-md hover:bg-row-hover-overlay focus-visible:bg-row-hover-overlay transition-colors text-left focus:outline-none"
            >
              <span class="shrink-0 w-4 h-4 flex items-center">
                <Icon name="magnifying-glass" class="text-icon-base" />
              </span>
              <span class="text-13-medium text-fg-base min-w-0 flex-1 truncate">{language.t("sidebar.pawwork.search")}</span>
            </button>
          </TooltipKeybind>
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
          data-component="pawwork-side-scroll"
          class="flex-1 min-h-0 overflow-y-auto px-3 pb-3"
        >
          <Show when={props.sessions().length > 0}>
            <nav class="flex flex-col">
              <Show when={pinnedRows().length > 0}>
                <section data-component="pawwork-sidebar-pinned" class="flex flex-col gap-0.5">
                  <div class="mt-4 h-[32px] flex items-center px-2.5 text-13-regular text-fg-weak">{language.t("sidebar.pawwork.pinned")}</div>
                  <For each={pinnedRows()}>{(entry) => renderSessionItem(entry)}</For>
                </section>
              </Show>
              <Show when={rows().length > 0 || groupedRows().length > 0}>
                <div class="mt-4 h-[32px] flex items-center justify-between px-2.5">
                  <span class="text-13-regular text-fg-weak">{language.t("sidebar.pawwork.all")}</span>
                  <DropdownMenu>
                    <Tooltip placement="bottom" value={language.t("sidebar.pawwork.sort.label")}>
                      <DropdownMenu.Trigger
                        as={IconButton}
                        data-action="pawwork-sort-trigger"
                        data-mode={props.sortMode()}
                        icon="sort"
                        aria-label={language.t("sidebar.pawwork.sort.label")}
                      />
                    </Tooltip>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content>
                        <DropdownMenu.Item
                          data-action="pawwork-sort-option"
                          data-value="time"
                          onSelect={() => props.onSetSortMode("time")}
                        >
                          <Icon name="schedule" class="text-icon-weak" />
                          <DropdownMenu.ItemLabel>
                            {language.t("sidebar.pawwork.sort.optionByTime")}
                          </DropdownMenu.ItemLabel>
                          <Show when={props.sortMode() === "time"}>
                            <Icon name="check" class="ml-auto text-icon-weak" />
                          </Show>
                        </DropdownMenu.Item>
                        <DropdownMenu.Item
                          data-action="pawwork-sort-option"
                          data-value="project"
                          onSelect={() => props.onSetSortMode("project")}
                        >
                          <Icon name="folder" class="text-icon-weak" />
                          <DropdownMenu.ItemLabel>
                            {language.t("sidebar.pawwork.sort.optionByProject")}
                          </DropdownMenu.ItemLabel>
                          <Show when={props.sortMode() === "project"}>
                            <Icon name="check" class="ml-auto text-icon-weak" />
                          </Show>
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu>
                </div>
              </Show>
              <Show when={props.sortMode() === "time"}>
                <div class="flex flex-col gap-0.5">
                  <For each={rows()}>{(entry) => renderSessionItem(entry)}</For>
                </div>
              </Show>
              <Show when={props.sortMode() === "project"}>
                <For each={groupedRows()}>
                  {(group, index) => {
                    const collapsed = createMemo(() => !!props.collapsedProjects()[group.label])
                    return (
                      <section class={`${index() > 0 ? "mt-0.5 " : ""}flex flex-col gap-0.5`}>
                        <button
                          type="button"
                          data-component="pawwork-group-header"
                          data-action="pawwork-group-toggle"
                          data-collapsed={collapsed() ? "true" : undefined}
                          aria-expanded={!collapsed()}
                          onClick={() => props.onToggleProjectCollapsed(group.label)}
                          class="group/group-header h-[32px] flex items-center gap-2 rounded-sm px-2.5 text-13-regular text-fg-weak transition-colors hover:bg-row-hover-overlay focus:outline-none focus-visible:bg-row-hover-overlay"
                        >
                          <Icon name="folder" class="shrink-0 text-icon-weak" />
                          <span class="min-w-0 flex-1 truncate text-left">{group.label}</span>
                          <Icon
                            name="chevron-down"
                            class="shrink-0 text-icon-weak transition-[opacity,transform] duration-150"
                            classList={{
                              "-rotate-90 opacity-100": collapsed(),
                              "opacity-0 group-hover/group-header:opacity-100 group-focus-visible/group-header:opacity-100":
                                !collapsed(),
                            }}
                          />
                        </button>
                        {/* grid-template-rows trick: 0fr → 1fr animates height without
                          * touching layout-thrashing properties. Items stay mounted so
                          * focus / scroll position survive the toggle; inert on the
                          * inner wrapper takes them out of the tab order while collapsed. */}
                        <div
                          class="grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
                          style={{ "grid-template-rows": collapsed() ? "0fr" : "1fr" }}
                          aria-hidden={collapsed()}
                        >
                          <div
                            class="min-h-0 overflow-hidden flex flex-col gap-0.5"
                            inert={collapsed() ? true : undefined}
                          >
                            <For each={group.items}>{(item) => renderSessionItem({ item })}</For>
                          </div>
                        </div>
                      </section>
                    )
                  }}
                </For>
              </Show>
              <Show when={props.sessionWindow().canShowMore}>
                <button
                  type="button"
                  data-action="pawwork-session-show-more"
                  disabled={props.sessionWindow().loading}
                  onClick={props.onShowMore}
                  class="mt-2 w-full rounded-md px-2.5 py-1.5 text-left text-13-regular text-fg-weak transition-colors hover:bg-row-hover-overlay hover:text-fg-base focus:outline-none focus-visible:bg-row-hover-overlay disabled:opacity-50"
                >
                  {props.sessionWindow().loading ? language.t("common.loading") : language.t("common.showMore")}
                </button>
              </Show>
              <Show when={props.sessionWindow().capReached}>
                <button
                  type="button"
                  data-action="pawwork-session-search-history"
                  onClick={props.onSearchOlderSessions}
                  class="mt-2 w-full rounded-md px-2.5 py-1.5 text-left text-13-regular text-fg-weak transition-colors hover:bg-row-hover-overlay hover:text-fg-base focus:outline-none focus-visible:bg-row-hover-overlay"
                >
                  {language.t("sidebar.pawwork.searchHistory")}
                </button>
              </Show>
            </nav>
          </Show>
        </div>
      </Show>

      <div
        data-component="pawwork-side-foot"
        class="shrink-0 px-3 pt-4 pb-3"
      >
        <TooltipKeybind
          placement="top"
          title={props.settingsLabel()}
          keybind={props.settingsKeybind() ?? ""}
        >
          <button
            type="button"
            data-action="pawwork-open-settings"
            onClick={props.onOpenSettings}
            aria-label={props.settingsLabel()}
            class="w-full h-[32px] flex items-center gap-2 px-2.5 rounded-md hover:bg-row-hover-overlay focus-visible:bg-row-hover-overlay transition-colors text-left focus:outline-none"
          >
            <span class="shrink-0 w-4 h-4 flex items-center">
              <Icon name="settings-gear" class="text-icon-base" />
            </span>
            <span class="text-13-medium text-fg-base min-w-0 flex-1 truncate">{props.settingsLabel()}</span>
          </button>
        </TooltipKeybind>
      </div>
    </section>
  )
}
