import type { Session } from "@opencode-ai/sdk/v2/client"
import { Button } from "@opencode-ai/ui/button"
import { ContextMenu } from "@opencode-ai/ui/context-menu"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { createEffect, createMemo, createSignal, For, Show, type Accessor, type JSX } from "solid-js"
import { useLanguage } from "@/context/language"
import { getRelativeTime } from "@/utils/time"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Tooltip, TooltipKeybind } from "@opencode-ai/ui/tooltip"
import { DialogRenameSession } from "@/components/dialog-rename-session"
import { DialogRenameProject } from "@/components/dialog-rename-project"
import { DialogRemoveProject } from "@/components/dialog-remove-project"
import { buildPawworkSessionSections, type PawworkSortMode } from "./pawwork-session-nav"
import { createSortableAttacher } from "./pawwork-sidebar-drag"
import { buildPawworkSidebarCollections } from "./pawwork-sidebar-identity"
import { buildSessionMenuActions, type SessionMenuAction } from "./session-menu-actions"
import { SessionItem, type SessionSwitchPaint } from "./sidebar-items"
import { shouldUseShellOwnerForLink } from "./sidebar-item-navigation"
import "./sidebar.css"

export type PawworkSidebarSession = {
  session: Session
  slug: string
  projectKey: string
  projectLabel: string
  created: number
}

function ProjectGroupHeader(props: {
  projectKey: string
  label: string
  collapsed: boolean
  onToggle: () => void
  onRename: () => void
  onRemove: () => void
}) {
  const language = useLanguage()
  const projectMenuLabels = () => ({
    rename: language.t("project.rename"),
    remove: language.t("project.remove"),
  })

  return (
    <ContextMenu>
      <ContextMenu.Trigger as="div">
        <div
          data-component="pawwork-group-header"
          data-collapsed={props.collapsed ? "true" : undefined}
          title={props.projectKey}
          class="group/group-header h-[30px] w-full flex items-center rounded-sm text-body text-fg-weak transition-colors hover:bg-row-hover-overlay focus-within:bg-row-hover-overlay"
        >
          <button
            type="button"
            data-action="pawwork-group-toggle"
            data-collapsed={props.collapsed ? "true" : undefined}
            aria-expanded={!props.collapsed}
            onClick={props.onToggle}
            class="min-w-0 h-full flex-1 flex items-center gap-2 px-2.5 text-left focus:outline-none"
          >
            <Icon name={props.collapsed ? "folder" : "folder-open"} class="shrink-0 text-icon-weak" />
            <span class="min-w-0 flex-1 truncate">{props.label}</span>
          </button>
          <div class="pointer-events-none relative shrink-0 flex items-center justify-end h-[20px] min-w-[30px] pr-1">
            <div class="absolute inset-y-0 right-1 flex items-center justify-end opacity-0 pointer-events-none group-hover/group-header:opacity-100 group-hover/group-header:pointer-events-auto group-focus-within/group-header:opacity-100 group-focus-within/group-header:pointer-events-auto group-has-[[data-expanded]]/group-header:opacity-100 group-has-[[data-expanded]]/group-header:pointer-events-auto">
              <DropdownMenu>
                <DropdownMenu.Trigger
                  as={IconButton}
                  icon="dot-grid"
                  variant="ghost"
                  class="pointer-events-auto h-[26px] w-[26px]"
                  data-action="project-row-menu"
                  aria-label={language.t("common.moreOptions")}
                />
                <DropdownMenu.Portal>
                  <DropdownMenu.Content>
                    <DropdownMenu.Item onSelect={props.onRename}>
                      <Icon name="edit" class="text-icon-weak" />
                      <DropdownMenu.ItemLabel>{projectMenuLabels().rename}</DropdownMenu.ItemLabel>
                    </DropdownMenu.Item>
                    <DropdownMenu.Item onSelect={props.onRemove}>
                      <Icon name="archive" class="text-icon-weak" />
                      <DropdownMenu.ItemLabel>{projectMenuLabels().remove}</DropdownMenu.ItemLabel>
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu>
            </div>
          </div>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content>
          <ContextMenu.Item onSelect={props.onRename}>
            <Icon name="edit" class="text-icon-weak" />
            <ContextMenu.ItemLabel>{projectMenuLabels().rename}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
          <ContextMenu.Item onSelect={props.onRemove}>
            <Icon name="archive" class="text-icon-weak" />
            <ContextMenu.ItemLabel>{projectMenuLabels().remove}</ContextMenu.ItemLabel>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu>
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
  collapsedProjects: Accessor<Record<string, boolean>>
  onToggleProjectCollapsed: (label: string) => void
  setScrollContainerRef: (el: HTMLDivElement | undefined) => void
  prefetchSession: (session: Session, priority?: "high" | "low") => void
  hrefForSession?: (session: Session) => string
  onOpenSession: (session: Session) => void
  onRenameSession: (session: Session, next: string) => Promise<void>
  onRenameProject: (projectKey: string, next: string) => Promise<void>
  onRemoveProject: (projectKey: string) => void
  onTogglePinnedSession: (sessionID: string) => void
  /**
   * Cross-zone drag (All ⇄ Pinned + intra-Pinned reorder). Indexes are passed
   * in visible (rendered) space; the caller reconciles with un-loaded pinned
   * IDs. When omitted, drag is disabled.
   */
  onDragSession?: (input: {
    sessionID: string
    targetSection: "pinned" | "recent"
    visiblePinnedIDs: string[]
    visibleTargetIndex: number
  }) => void
  /** Keyboard-driven move up / down within the visible pinned zone (⌥↑ / ⌥↓ on a pinned row). */
  onMovePinnedSession?: (input: { sessionID: string; direction: "up" | "down"; visiblePinnedIDs: string[] }) => void
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
  const [switchPaint, setSwitchPaint] = createSignal<SessionSwitchPaint | undefined>()
  const navList = createMemo(() => props.sessions().map((item) => item.session))
  let scrollEl: HTMLDivElement | undefined
  const sections = createMemo(() =>
    buildPawworkSessionSections({
      sessions: props.sessions().map((item) => ({
        id: item.session.id,
        title: item.session.title ?? "",
        directory: item.session.directory,
        projectKey: item.projectKey,
        projectLabel: item.projectLabel,
        created: item.created,
      })),
      pinnedIDs: props.pinnedIDs(),
      sortMode: props.sortMode(),
    }),
  )
  const sidebarCollections = createMemo(() =>
    buildPawworkSidebarCollections({ sessions: props.sessions(), sections: sections() }),
  )
  /**
   * Pinned session IDs in rendered order. This is the single source of truth
   * for drag insertion targets and menu Move-up / Move-down adjacency — both
   * stay coupled to what the user actually sees, decoupled from any
   * un-loaded pinned IDs persisted in the raw array.
   */
  const visiblePinnedIDs = createMemo(() => {
    const { pinnedRowKeys, rowByKey } = sidebarCollections()
    const ids: string[] = []
    for (const key of pinnedRowKeys) {
      const row = rowByKey.get(key)
      if (row) ids.push(row.session.id)
    }
    return ids
  })

  const openRenameDialog = (target: Session) => {
    dialog.show(() => (
      <DialogRenameSession name={target.title ?? ""} onConfirm={(next) => props.onRenameSession(target, next)} />
    ))
  }

  const openRenameProjectDialog = (projectKey: string, currentLabel: string) => {
    dialog.show(() => (
      <DialogRenameProject name={currentLabel} onConfirm={(next) => props.onRenameProject(projectKey, next)} />
    ))
  }

  const openRemoveProjectDialog = (projectKey: string, projectLabel: string) => {
    dialog.show(() => <DialogRemoveProject name={projectLabel} onConfirm={() => props.onRemoveProject(projectKey)} />)
  }

  const menuLabels = () => ({
    pin: language.t("sidebar.pawwork.pinSession"),
    unpin: language.t("sidebar.pawwork.unpinSession"),
    rename: language.t("common.rename"),
    export: language.t("session.export.action.export"),
    delete: language.t("common.delete"),
  })
  const menuActions = (target: Session, onRenameSession: (session: Session) => void) => {
    const isPinned = visiblePinnedIDs().includes(target.id) || props.pinnedIDs().includes(target.id)
    return buildSessionMenuActions({
      session: target,
      pinned: isPinned,
      exportAvailable: props.exportSessionAvailable(),
      labels: menuLabels(),
      onTogglePinnedSession: props.onTogglePinnedSession,
      onRenameSession,
      onExportSession: props.onExportSession,
      onDeleteSession: props.onDeleteSession,
    })
  }

  // Keyboard-accessible reorder for pinned rows: when focus is anywhere inside a
  // pinned row, ⌥↑ / ⌥↓ (Alt+Arrow) moves it within the pinned zone. This is the
  // keyboard equivalent of mouse drag — drag is pointer-only and cannot serve
  // keyboard users on its own. Rows whose id is not in the visible pinned order
  // ignore the keys and let the browser default stand, so non-pinned rows and
  // the list edges are silent no-ops.
  const onPinnedRowKeyDown = (event: KeyboardEvent, session: Session) => {
    if (!event.altKey) return
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
    const visibleIDs = visiblePinnedIDs()
    const index = visibleIDs.indexOf(session.id)
    if (index === -1) return
    event.preventDefault()
    const direction = event.key === "ArrowUp" ? "up" : "down"
    if (direction === "up" && index === 0) return
    if (direction === "down" && index === visibleIDs.length - 1) return
    props.onMovePinnedSession?.({ sessionID: session.id, direction, visiblePinnedIDs: visibleIDs })
    // The row keeps its session id across the move; re-focus it next frame so
    // repeated ⌥↑/↓ keep working without Tabbing back into the list.
    requestAnimationFrame(() => {
      const row = scrollEl?.querySelector<HTMLElement>(`[data-session-id="${session.id}"]`)
      row?.querySelector<HTMLElement>('a, [data-action="session-row-menu"]')?.focus()
    })
  }
  const markSessionSwitchPaint = (session: Session, event: MouseEvent) => {
    if (!shouldUseShellOwnerForLink(event)) return
    const sourceID = props.activeSessionID?.()
    if (!sourceID || sourceID === session.id) {
      setSwitchPaint(undefined)
      return
    }
    setSwitchPaint({ sourceID, targetID: session.id })
  }
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

  const renderSessionItem = (row: Accessor<PawworkSidebarSession | undefined>) => {
    return (
      <Show when={row()}>
        {(current) => (
          <ContextMenu>
            {/* The inner SessionItem already carries `data-session-id`, which
              * many e2e tests locate by; keep the drag wrapper free of a
              * second copy to avoid strict-mode duplicate matches.
              *
              * The wrapper does carry `data-pw-drag-session-id` so SortableJS
              * has a single canonical source of truth for "which session is
              * being dragged" — independent of how SessionItem renders its
              * subtree (it can recursively render an active child row, which
              * would otherwise make a descendant-querySelector lookup fragile). */}
            <ContextMenu.Trigger
              as="div"
              class="flex flex-col gap-1 pw-drag-row"
              data-pw-drag-session-id={current().session.id}
              onKeyDown={(event: KeyboardEvent) => onPinnedRowKeyDown(event, current().session)}
            >
              <SessionItem
                session={current().session}
                list={navList()}
                reorderHint={visiblePinnedIDs().includes(current().session.id)}
                navList={navList}
                slug={current().slug}
                showChild
                prefetchSession={props.prefetchSession}
                hrefForSession={props.hrefForSession}
                onOpenSession={props.onOpenSession}
                switchPaint={switchPaint}
                onSwitchPaint={markSessionSwitchPaint}
                timeText={() =>
                  current().created > 0
                    ? getRelativeTime(new Date(current().created).toISOString(), language.t)
                    : undefined
                }
                titleContent={({ title }) => (
                  <span
                    class="text-body text-fg-base [.active_&]:text-fg-strong [.active_&]:font-emphasis min-w-0 flex-1 truncate"
                    onDblClick={(e: MouseEvent) => {
                      e.preventDefault()
                      e.stopPropagation()
                      openRenameDialog(current().session)
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
                      class="h-[26px] w-[26px]"
                      data-action="session-row-menu"
                      aria-label={language.t("common.moreOptions")}
                      onClick={(event: MouseEvent) => {
                        event.preventDefault()
                        event.stopPropagation()
                      }}
                    />
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content>
                        {renderDropdownActions(menuActions(rowSession, () => openRenameDialog(rowSession)))}
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu>
                )}
              />
            </ContextMenu.Trigger>
            <ContextMenu.Portal>
              <ContextMenu.Content>
                {renderContextActions(menuActions(current().session, () => openRenameDialog(current().session)))}
              </ContextMenu.Content>
            </ContextMenu.Portal>
          </ContextMenu>
        )}
      </Show>
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
    const current = switchPaint()
    if (!current) return
    if (props.activeSessionID?.() !== current.targetID) return

    requestAnimationFrame(() => {
      setSwitchPaint((latest) => (latest === current ? undefined : latest))
    })
  })

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

  // "按需浮现": the empty pinned section appears as a drop target only during
  // drag (see Show condition below). isDragging is also used by the sortable
  // attacher's onStart/onEnd.
  const [isDragging, setIsDragging] = createSignal(false)

  // Drag wiring lives in pawwork-sidebar-drag.ts so the spike's accumulated
  // patterns (DOM revert, newDraggableIndex semantics, project-group put rule,
  // no-op bail, etc.) stay together and out of this render-heavy component.
  const attachSortable = createSortableAttacher({
    onDragSession: props.onDragSession,
    setIsDragging,
    getVisiblePinnedIDs: visiblePinnedIDs,
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
              class="w-full h-[30px] flex items-center gap-2 px-2.5 rounded-md hover:bg-row-hover-overlay focus-visible:bg-row-hover-overlay transition-colors text-left focus:outline-none"
            >
              <span class="shrink-0 w-4 h-4 flex items-center">
                <Icon name="new-session" class="text-icon-base" />
              </span>
              <span class="text-h3 text-fg-base min-w-0 flex-1 truncate">{language.t("command.session.new")}</span>
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
              class="w-full h-[30px] flex items-center gap-2 px-2.5 rounded-md hover:bg-row-hover-overlay focus-visible:bg-row-hover-overlay transition-colors text-left focus:outline-none"
            >
              <span class="shrink-0 w-4 h-4 flex items-center">
                <Icon name="magnifying-glass" class="text-icon-base" />
              </span>
              <span class="text-h3 text-fg-base min-w-0 flex-1 truncate">{language.t("sidebar.pawwork.search")}</span>
            </button>
          </TooltipKeybind>
        </div>
      </div>

      <Show
        when={!props.showProjectEmptyState}
        fallback={
          <div class="flex flex-1 items-center px-5">
            <div class="flex w-full flex-col gap-3">
              <div class="text-h3 text-fg-strong">{language.t("sidebar.empty.title")}</div>
              <p class="text-body text-fg-weak">{language.t("sidebar.pawwork.empty.description")}</p>
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
              {/* Pinned section is visible when it has items, or transiently
                * during any drag (按需浮现 — empty drop target). Sortable attaches
                * in both time and project mode now: project groups can pull rows
                * here, and pinned rows can be pulled out into their owning
                * project group (which still rejects cross-project drops). */}
              <Show when={sidebarCollections().pinnedRowKeys.length > 0 || isDragging()}>
                <section data-component="pawwork-sidebar-pinned" class="flex flex-col gap-0.5">
                  <div class="mt-4 h-[30px] flex items-center px-2.5 text-body text-fg-weak">
                    {language.t("sidebar.pawwork.pinned")}
                  </div>
                  {/* Placeholder lives OUTSIDE the Sortable container — Sortable
                    * counts every child for index math, so a non-draggable sibling
                    * would skew positions. Absolute-position over a min-height
                    * Sortable container so the empty zone still has hit area. */}
                  <div class="relative">
                    <div
                      ref={attachSortable("pinned")}
                      data-component="pawwork-pinned-list"
                      class="flex flex-col gap-0.5 min-h-[30px]"
                    >
                      <For each={sidebarCollections().pinnedRowKeys}>
                        {(rowKey) => {
                          const row = createMemo(() => sidebarCollections().rowByKey.get(rowKey))
                          return renderSessionItem(row)
                        }}
                      </For>
                    </div>
                    <Show when={sidebarCollections().pinnedRowKeys.length === 0}>
                      <div
                        data-component="pawwork-pinned-empty"
                        class="pointer-events-none absolute inset-0 flex items-center px-2.5 text-body text-fg-weak/60 italic"
                      >
                        {language.t("sidebar.pawwork.dragToPin")}
                      </div>
                    </Show>
                  </div>
                </section>
              </Show>
              <Show when={sidebarCollections().recentRowKeys.length > 0 || sidebarCollections().groupKeys.length > 0}>
                <div class="mt-4 h-[30px] flex items-center justify-between px-2.5">
                  <span class="text-body text-fg-weak">{language.t("sidebar.pawwork.all")}</span>
                  <DropdownMenu>
                    <Tooltip placement="bottom" value={language.t("sidebar.pawwork.sort.label")}>
                      <DropdownMenu.Trigger
                        as={IconButton}
                        data-action="pawwork-sort-trigger"
                        data-mode={props.sortMode()}
                        icon="sort"
                        class="h-[26px] w-[26px]"
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
                <div ref={attachSortable("recent")} data-component="pawwork-recent-list" class="flex flex-col gap-0.5">
                  <For each={sidebarCollections().recentRowKeys}>
                    {(rowKey) => {
                      const row = createMemo(() => sidebarCollections().rowByKey.get(rowKey))
                      return renderSessionItem(row)
                    }}
                  </For>
                </div>
              </Show>
              <Show when={props.sortMode() === "project"}>
                <For each={sidebarCollections().groupKeys}>
                  {(groupKey, index) => {
                    const group = createMemo(() => sidebarCollections().groupByKey.get(groupKey))
                    const collapsed = createMemo(() => !!props.collapsedProjects()[groupKey])
                    const handleRename = () => openRenameProjectDialog(groupKey, group()?.label ?? groupKey)
                    const handleRemove = () => openRemoveProjectDialog(groupKey, group()?.label ?? groupKey)

                    return (
                      <Show when={group()}>
                        {(current) => (
                          <section class={`${index() > 0 ? "mt-0.5 " : ""}flex flex-col gap-0.5`}>
                            <ProjectGroupHeader
                              projectKey={groupKey}
                              label={current().label}
                              collapsed={collapsed()}
                              onToggle={() => props.onToggleProjectCollapsed(groupKey)}
                              onRename={handleRename}
                              onRemove={handleRemove}
                            />
                            {/* grid-template-rows trick: 0fr → 1fr animates height without
                             * touching layout-thrashing properties. Items stay mounted so
                             * focus / scroll position survive the toggle; inert on the
                             * inner wrapper takes them out of the tab order while collapsed. */}
                            <div
                              data-component="pawwork-group-content"
                              data-collapsed={collapsed() ? "true" : undefined}
                              class="grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
                              style={{ "grid-template-rows": collapsed() ? "0fr" : "1fr" }}
                              aria-hidden={collapsed()}
                            >
                              <div
                                ref={attachSortable("project-group")}
                                data-component="pawwork-project-group-list"
                                class="min-h-0 overflow-hidden flex flex-col gap-0.5"
                                inert={collapsed() ? true : undefined}
                              >
                                <For each={current().rowKeys}>
                                  {(rowKey) => {
                                    const row = createMemo(() => sidebarCollections().rowByKey.get(rowKey))
                                    return renderSessionItem(row)
                                  }}
                                </For>
                              </div>
                            </div>
                          </section>
                        )}
                      </Show>
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
                  class="mt-2 w-full rounded-md px-2.5 py-1.5 text-left text-body text-fg-weak transition-colors hover:bg-row-hover-overlay hover:text-fg-base focus:outline-none focus-visible:bg-row-hover-overlay disabled:opacity-50"
                >
                  {props.sessionWindow().loading ? language.t("common.loading") : language.t("common.showMore")}
                </button>
              </Show>
              <Show when={props.sessionWindow().capReached}>
                <button
                  type="button"
                  data-action="pawwork-session-search-history"
                  onClick={props.onSearchOlderSessions}
                  class="mt-2 w-full rounded-md px-2.5 py-1.5 text-left text-body text-fg-weak transition-colors hover:bg-row-hover-overlay hover:text-fg-base focus:outline-none focus-visible:bg-row-hover-overlay"
                >
                  {language.t("sidebar.pawwork.searchHistory")}
                </button>
              </Show>
            </nav>
          </Show>
        </div>
      </Show>

      <div data-component="pawwork-side-foot" class="shrink-0 px-3 pt-4 pb-3">
        <TooltipKeybind placement="top" title={props.settingsLabel()} keybind={props.settingsKeybind() ?? ""}>
          <button
            type="button"
            data-action="pawwork-open-settings"
            onClick={props.onOpenSettings}
            aria-label={props.settingsLabel()}
            class="w-full h-[30px] flex items-center gap-2 px-2.5 rounded-md hover:bg-row-hover-overlay focus-visible:bg-row-hover-overlay transition-colors text-left focus:outline-none"
          >
            <span class="shrink-0 w-4 h-4 flex items-center">
              <Icon name="settings-gear" class="text-icon-base" />
            </span>
            <span class="text-h3 text-fg-base min-w-0 flex-1 truncate">{props.settingsLabel()}</span>
          </button>
        </TooltipKeybind>
      </div>
    </section>
  )
}
