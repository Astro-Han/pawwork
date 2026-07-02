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
import { DialogRenameSession } from "@/components/dialog-rename-session"
import { DialogRenameProject } from "@/components/dialog-rename-project"
import { DialogRemoveProject } from "@/components/dialog-remove-project"
import { buildPawworkSessionSections, type PawworkSortMode } from "./pawwork-session-nav"
import { createSortableAttacher } from "./pawwork-sidebar-drag"
import { buildPawworkSidebarCollections } from "./pawwork-sidebar-identity"
import { PawworkSidebarAllHeader } from "./pawwork-sidebar-all-header"
import { PawworkSidebarFoot } from "./pawwork-sidebar-foot"
import { PawworkSidebarTop } from "./pawwork-sidebar-top"
import { ProjectGroupHeader } from "./pawwork-sidebar-project-group-header"
import { isPawworkDirectStartProjectKey } from "./pawwork-session-source"
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
  searchAvailable: Accessor<boolean>
  onOpenProject: () => void
  onOpenSkills: () => void
  skillsActive: Accessor<boolean>
  skillsLabel: Accessor<string>
  onOpenAutomations: () => void
  automationsActive: Accessor<boolean>
  automationsLabel: Accessor<string>
  onOpenRemote: () => void
  remoteActive: Accessor<boolean>
  remoteLabel: Accessor<string>
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
    // Alt and only Alt — Ctrl/Cmd/Shift combos belong to other shortcuts.
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
    // The handler sits on the row wrapper, which also wraps the active child row
    // and the "…" menu button. Only the row's main LINK owns ⌥↑/⌥↓ — matching the
    // keycap hint, which sidebar.css reveals on `a:focus-visible` only. Focus on the
    // "…" button (not an <a>) or a nested child row's link therefore never reorders.
    const link = (event.target as HTMLElement | null)?.closest?.("a")
    const originID = link?.closest?.("[data-session-id]")?.getAttribute("data-session-id")
    if (!link || originID !== session.id) return
    const visibleIDs = visiblePinnedIDs()
    const index = visibleIDs.indexOf(session.id)
    if (index === -1) return
    // This pinned row owns ⌥↑/⌥↓. session.previous/next bind the SAME alt+arrow on
    // a document-level keydown listener. Solid delegates keydown to document too,
    // so that listener sits on the same node as ours — stopPropagation alone would
    // not stop it (it only blocks bubbling to ancestors, not co-located listeners).
    // stopImmediatePropagation blocks the other document listener, so a reorder —
    // and an edge no-op — never also navigates to another session.
    event.preventDefault()
    event.stopImmediatePropagation()
    const direction = event.key === "ArrowUp" ? "up" : "down"
    if (direction === "up" && index === 0) return
    if (direction === "down" && index === visibleIDs.length - 1) return
    props.onMovePinnedSession?.({ sessionID: session.id, direction, visiblePinnedIDs: visibleIDs })
    // The row keeps its session id across the move; re-focus its link next frame
    // so repeated ⌥↑/↓ keep working without Tabbing back into the list.
    requestAnimationFrame(() => {
      const row = scrollEl?.querySelector<HTMLElement>(`[data-session-id="${session.id}"]`)
      row?.querySelector<HTMLElement>("a")?.focus()
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
      <PawworkSidebarTop
        newSessionKeybind={props.newSessionKeybind}
        searchKeybind={props.searchKeybind}
        skillsActive={props.skillsActive}
        skillsLabel={props.skillsLabel}
        automationsActive={props.automationsActive}
        automationsLabel={props.automationsLabel}
        remoteActive={props.remoteActive}
        remoteLabel={props.remoteLabel}
        onNew={props.onNew}
        onSearch={props.onSearch}
        searchAvailable={props.searchAvailable}
        onOpenSkills={props.onOpenSkills}
        onOpenAutomations={props.onOpenAutomations}
        onOpenRemote={props.onOpenRemote}
      />

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
          {/* Keep the nav (and its Show more / search-history entries) mounted
            * whenever the window can still load or has hit the cap, even if the
            * current filtered list is empty — otherwise a page of closed-project
            * sessions filters to nothing and the only way to load deeper would
            * vanish with the list. */}
          <Show when={props.sessions().length > 0 || props.sessionWindow().canShowMore || props.sessionWindow().capReached}>
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
                <PawworkSidebarAllHeader sortMode={props.sortMode} onSetSortMode={props.onSetSortMode} />
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
                              kind={isPawworkDirectStartProjectKey(groupKey) ? "direct-start" : "project"}
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

      <PawworkSidebarFoot
        settingsLabel={props.settingsLabel}
        settingsKeybind={props.settingsKeybind}
        onOpenSettings={props.onOpenSettings}
      />
    </section>
  )
}
