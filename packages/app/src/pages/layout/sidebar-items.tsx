import type { Session } from "@opencode-ai/sdk/v2/client"
import { Icon } from "@opencode-ai/ui/icon"
import { Keybind } from "@opencode-ai/ui/keybind"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { A, useParams } from "@solidjs/router"
import { type Accessor, createMemo, For, type JSX, Show } from "solid-js"
import { formatKeybind } from "@/context/command"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { useShellSurface } from "@/context/shell-surface"
import { messageAgentColor } from "@/utils/agent"
import { sessionTitle } from "@/utils/session-title"
import { sessionPermissionRequest } from "../session/blockers/request-tree"
import { findDescendantExternalResultQuestion } from "../session/blockers/running-external-result-question"
import { createSessionRunning } from "../session/session-running-state"
import { childSessionOnPath } from "./helpers"
import { sidebarStatusKind } from "./sidebar-status-kind"
import { defaultNewSessionHref, defaultSessionHref, openShellLinkWithOwner } from "./sidebar-item-navigation"

export type SessionSwitchPaint = {
  sourceID: string
  targetID: string
}

export type SessionItemProps = {
  session: Session
  list: Session[]
  navList?: Accessor<Session[]>
  slug: string
  showTooltip?: boolean
  showChild?: boolean
  level?: number
  prefetchSession: (session: Session, priority?: "high" | "low") => void
  hrefForSession?: (session: Session) => string
  onOpenSession?: (session: Session) => void
  onSwitchPaint?: (session: Session, event: MouseEvent) => void
  switchPaint?: Accessor<SessionSwitchPaint | undefined>
  titleContent?: (input: { session: Session; title: Accessor<string> }) => JSX.Element
  actionSlot?: (session: Session) => JSX.Element
  timeText?: (session: Session) => string | undefined
  /** When true (pinned rows), keyboard focus reveals the ⌥↑ / ⌥↓ reorder caps. */
  reorderHint?: boolean
}

const SessionRow = (props: {
  session: Session
  slug: string
  warmPress: () => void
  warmFocus: () => void
  href: string
  onOpenSession?: (event: MouseEvent) => void
  onSwitchPaint?: (event: MouseEvent) => void
  titleContent?: JSX.Element
}): JSX.Element => {
  const title = () => sessionTitle(props.session.title)
  const shellSurface = useShellSurface()

  return (
    <A
      href={props.href}
      // While the Automations surface owns the main region the session route is
      // still mounted, so router keeps this link `.active` and the row stays
      // highlighted alongside the Automations nav item. Swap the active class to
      // a no-op while automations is open so sidebar selection stays mutually
      // exclusive with the surface. The row overlay + text emphasis both key off
      // `.active` (sidebar.css `:has(.active)`), so this clears them in one move.
      activeClass={shellSurface.automationsOpen() ? "pw-route-active-suppressed" : "active"}
      class="flex items-center min-w-0 w-full text-left focus:outline-none"
      onPointerDown={props.warmPress}
      onFocus={props.warmFocus}
      onClick={(event) => {
        props.onSwitchPaint?.(event)
        props.onOpenSession?.(event)
      }}
    >
      <Show
        when={props.titleContent}
        fallback={
          <span class="text-body text-fg-base [.active_&]:text-fg-strong [.active_&]:font-emphasis min-w-0 flex-1 truncate">
            {title()}
          </span>
        }
      >
        {props.titleContent}
      </Show>
    </A>
  )
}

export const SessionItem = (props: SessionItemProps): JSX.Element => {
  const params = useParams()
  const notification = useNotification()
  const permission = usePermission()
  const globalSync = useGlobalSync()
  const language = useLanguage()
  const hasError = createMemo(() => notification.session.unseenHasError(props.session.id))
  const [sessionStore] = globalSync.child(props.session.directory)
  // Sidebar "asking" must mirror the main-region blocker semantics (permission
  // || running external-result question), not just permission. Otherwise an
  // agent question() pause shows as busy in the sidebar while the main region
  // shows the question. See use-session-blockers.ts for the canonical OR set.
  const isAsking = createMemo(() => {
    if (
      sessionPermissionRequest(sessionStore.session, sessionStore.permission, props.session.id, (item) => {
        return !permission.autoResponds(item, props.session.directory)
      })
    )
      return true
    return (
      findDescendantExternalResultQuestion({
        sessions: sessionStore.session,
        rootSessionID: props.session.id,
        pendingQuestions: sessionStore.external_result_question,
        messages: sessionStore.message,
        partsByMessageID: sessionStore.part,
      }) !== undefined
    )
  })
  const sessionRunning = createSessionRunning(
    () => sessionStore.session_status[props.session.id],
    () => sessionStore.message[props.session.id],
  )

  const tint = createMemo(() => messageAgentColor(sessionStore.message[props.session.id], sessionStore.agent))
  const tooltip = createMemo(() => props.showTooltip ?? false)
  const switchPaintRole = createMemo(() => {
    const current = props.switchPaint?.()
    if (!current) return undefined
    if (current.targetID === props.session.id) return "target"
    if (current.sourceID === props.session.id) return "source"
    return undefined
  })
  const currentChild = createMemo(() => {
    if (!props.showChild) return
    return childSessionOnPath(sessionStore.session, props.session.id, params.id)
  })

  const statusKind = createMemo(() =>
    sidebarStatusKind({
      asking: isAsking(),
      busy: !!sessionRunning(),
      error: hasError(),
      unread: notification.session.unseenCount(props.session.id) > 0,
    }),
  )

  const statusContent = (): JSX.Element => {
    switch (statusKind()) {
      case "asking":
        return <Icon name="comment" class="text-brand-primary" />
      case "busy":
        return (
          <Spinner
            aria-label={language.t("common.loading")}
            class="size-[18px]"
            style={{ color: tint() ?? "var(--brand-primary)" }}
          />
        )
      case "error":
        return <Icon name="circle-x" class="text-error" />
      case "unread":
        return (
          <span
            aria-label={language.t("sidebar.session.unread")}
            role="img"
            class="block size-2 rounded-full bg-brand-primary"
          />
        )
      case "time": {
        const t = props.timeText?.(props.session)
        return t ? <span class="text-caption text-fg-weaker whitespace-nowrap">{t}</span> : null
      }
    }
  }

  const warm = (span: number, priority: "high" | "low") => {
    const nav = props.navList?.()
    const list = nav?.some((item) => item.id === props.session.id && item.directory === props.session.directory)
      ? nav
      : props.list

    props.prefetchSession(props.session, priority)

    const idx = list.findIndex((item) => item.id === props.session.id && item.directory === props.session.directory)
    if (idx === -1) return

    for (let step = 1; step <= span; step++) {
      const next = list[idx + step]
      if (next) props.prefetchSession(next, step === 1 ? "high" : priority)

      const prev = list[idx - step]
      if (prev) props.prefetchSession(prev, step === 1 ? "high" : priority)
    }
  }

  const item = (
    <SessionRow
      session={props.session}
      slug={props.slug}
      href={props.hrefForSession?.(props.session) ?? defaultSessionHref(props.slug, props.session)}
      onOpenSession={(event) => {
        if (!props.onOpenSession) return
        openShellLinkWithOwner(event, () => props.onOpenSession?.(props.session))
      }}
      onSwitchPaint={(event) => props.onSwitchPaint?.(props.session, event)}
      warmPress={() => warm(2, "high")}
      warmFocus={() => warm(2, "high")}
      titleContent={props.titleContent?.({ session: props.session, title: () => sessionTitle(props.session.title) ?? "" })}
    />
  )

  return (
    <>
      <div
        data-session-id={props.session.id}
        data-component="pawwork-session-row"
        data-switch-paint={switchPaintRole()}
        class="group/session relative w-full min-w-0 h-[30px] flex items-center rounded-md cursor-default pr-[10px]"
        // Sub-session indentation: base padding is 10 (sidebar row spec); add 16 per nesting level.
        // The flat-row spec locks left-side affordances at 10; nested-row indentation is a deliberate
        // visual departure to express parent/child without re-introducing accent bars.
        style={{ "padding-left": `${10 + (props.level ?? 0) * 16}px` }}
      >
        <div class="flex min-w-0 items-center gap-1 flex-1">
          <div class="min-w-0 flex-1">
            <Show
              when={!tooltip()}
              fallback={
                <Tooltip
                  placement="right"
                  value={sessionTitle(props.session.title)}
                  gutter={10}
                  class="min-w-0 w-full"
                >
                  {item}
                </Tooltip>
              }
            >
              {item}
            </Show>
          </div>

          <Show when={!props.level}>
            <div class="relative shrink-0 flex items-center justify-end h-[20px] min-w-[20px]">
              {/* default 4-state status (asking|busy|error|time). The row paint contract in
                 sidebar.css controls opacity so hover/menu/switching states stay in sync. */}
              <div data-status-default class="h-full min-w-[20px] flex items-center justify-center">
                {statusContent()}
              </div>
              {/* hover/focus/menu-open action overlay */}
              <div data-status-overlay class="absolute inset-y-0 right-0 flex items-center justify-end">
                <Show when={props.actionSlot}>{props.actionSlot?.(props.session)}</Show>
              </div>
              {/* keyboard-only reorder hint: pinned rows reveal ⌥↑ / ⌥↓ caps on
                 keyboard focus. sidebar.css gates visibility off :focus-visible,
                 so mouse hover never shows it. */}
              <Show when={props.reorderHint}>
                <div
                  data-status-reorder
                  aria-hidden="true"
                  class="absolute inset-y-0 right-0 flex items-center justify-end gap-1"
                >
                  <Keybind class="rounded-[4px]">{formatKeybind("alt+arrowup", language.t)}</Keybind>
                  <Keybind class="rounded-[4px]">{formatKeybind("alt+arrowdown", language.t)}</Keybind>
                </div>
              </Show>
            </div>
          </Show>
        </div>
      </div>
      <Show when={currentChild()}>
        {(child) => (
          <div class="w-full">
            {/* Child rows inherit props via spread; force the reorder hint off so
               nested sessions never show ⌥↑/⌥↓ — only the top-level pinned row reorders. */}
            <SessionItem {...props} session={child()} level={(props.level ?? 0) + 1} reorderHint={false} />
          </div>
        )}
      </Show>
    </>
  )
}

export const NewSessionItem = (props: {
  slug: string
  dense?: boolean
  onOpenNewSession?: () => void
}): JSX.Element => {
  const language = useLanguage()
  const shellSurface = useShellSurface()
  const label = language.t("command.session.new")
  const item = (
    <A
      href={defaultNewSessionHref(props.slug)}
      end
      activeClass={shellSurface.automationsOpen() ? "pw-route-active-suppressed" : "active"}
      class={`flex items-center gap-2 min-w-0 w-full text-left focus:outline-none leading-[1.4] ${props.dense ? "py-1" : "py-[5px]"}`}
      onClick={(event) => {
        if (!props.onOpenNewSession) return
        openShellLinkWithOwner(event, props.onOpenNewSession)
      }}
    >
      <div data-leading-slot class="shrink-0 w-4 h-4 flex items-center">
        <Icon name="new-session" class="text-icon-weak" />
      </div>
      <span class="text-body text-fg-base [.active_&]:text-fg-strong min-w-0 flex-1 truncate">{label}</span>
    </A>
  )

  return (
    <div class="group/session relative w-full min-w-0 rounded-md cursor-default transition-colors pl-2 pr-2 hover:bg-row-hover-overlay [&:has(:focus-visible)]:bg-row-hover-overlay has-[.active]:bg-row-active-overlay has-[.active]:hover:bg-row-active-overlay">
      {item}
    </div>
  )
}

export const SessionSkeleton = (props: { count?: number }): JSX.Element => {
  const items = Array.from({ length: props.count ?? 4 }, (_, index) => index)
  return (
    <div class="flex flex-col gap-0.5">
      <For each={items}>
        {() => <div class="h-[30px] w-full rounded-md bg-surface-raised opacity-60 animate-pulse" />}
      </For>
    </div>
  )
}
