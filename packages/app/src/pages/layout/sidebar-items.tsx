import type { Session } from "@opencode-ai/sdk/v2/client"
import { Avatar } from "@opencode-ai/ui/avatar"
import { Icon } from "@opencode-ai/ui/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Tooltip } from "@opencode-ai/ui/tooltip"
import { getFilename } from "@opencode-ai/util/path"
import { A, useParams } from "@solidjs/router"
import { type Accessor, createMemo, For, type JSX, Show } from "solid-js"
import { useGlobalSync } from "@/context/global-sync"
import { useLanguage } from "@/context/language"
import { getAvatarColors, type LocalProject } from "@/context/layout"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { messageAgentColor } from "@/utils/agent"
import { sessionTitle } from "@/utils/session-title"
import { sessionPermissionRequest } from "../session/composer/session-request-tree"
import { createSessionRunning } from "../session/session-running-state"
import { childSessionOnPath, hasProjectPermissions } from "./helpers"

export const ProjectIcon = (props: { project: LocalProject; class?: string; notify?: boolean }): JSX.Element => {
  const globalSync = useGlobalSync()
  const notification = useNotification()
  const permission = usePermission()
  const dirs = createMemo(() => [props.project.worktree, ...(props.project.sandboxes ?? [])])
  const unseenCount = createMemo(() =>
    dirs().reduce((total, directory) => total + notification.project.unseenCount(directory), 0),
  )
  const hasError = createMemo(() => dirs().some((directory) => notification.project.unseenHasError(directory)))
  const hasPermissions = createMemo(() =>
    dirs().some((directory) => {
      const [store] = globalSync.child(directory, { bootstrap: false })
      return hasProjectPermissions(store.permission, (item) => !permission.autoResponds(item, directory))
    }),
  )
  const notify = createMemo(() => props.notify && (hasPermissions() || unseenCount() > 0))
  const name = createMemo(() => props.project.name || getFilename(props.project.worktree))

  return (
    <div class={`relative size-8 shrink-0 rounded ${props.class ?? ""}`}>
      <div class="size-full rounded overflow-clip">
        <Avatar
          fallback={name()}
          src={props.project.icon?.override}
          {...getAvatarColors(props.project.icon?.color)}
          class="size-full rounded"
          classList={{ "badge-mask": notify() }}
        />
      </div>
      <Show when={notify()}>
        <div
          classList={{
            "absolute top-px right-px size-1.5 rounded-full z-10": true,
            "bg-surface-warning-strong": hasPermissions(),
            "bg-icon-critical-base": !hasPermissions() && hasError(),
            "bg-text-interactive-base": !hasPermissions() && !hasError(),
          }}
        />
      </Show>
    </div>
  )
}

export type SessionItemProps = {
  session: Session
  list: Session[]
  navList?: Accessor<Session[]>
  slug: string
  dense?: boolean
  showTooltip?: boolean
  showChild?: boolean
  level?: number
  prefetchSession: (session: Session, priority?: "high" | "low") => void
  titleContent?: (input: { session: Session; title: Accessor<string> }) => JSX.Element
  actionSlot?: (session: Session) => JSX.Element
  pinned?: (session: Session) => boolean
  timeText?: (session: Session) => string | undefined
}

const SessionRow = (props: {
  session: Session
  slug: string
  dense?: boolean
  warmPress: () => void
  warmFocus: () => void
  titleContent?: JSX.Element
}): JSX.Element => {
  const title = () => sessionTitle(props.session.title)

  return (
    <A
      href={`/${props.slug}/session/${props.session.id}`}
      class={`flex items-center min-w-0 w-full text-left focus:outline-none leading-[1.4] ${props.dense ? "py-1" : "py-[5px]"}`}
      onPointerDown={props.warmPress}
      onFocus={props.warmFocus}
    >
      <Show when={props.titleContent} fallback={<span class="text-13-regular text-text-base [.active_&]:text-text-strong min-w-0 flex-1 truncate">{title()}</span>}>
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
  const unseenCount = createMemo(() => notification.session.unseenCount(props.session.id))
  const hasError = createMemo(() => notification.session.unseenHasError(props.session.id))
  const [sessionStore] = globalSync.child(props.session.directory)
  const hasPermissions = createMemo(() => {
    return !!sessionPermissionRequest(sessionStore.session, sessionStore.permission, props.session.id, (item) => {
      return !permission.autoResponds(item, props.session.directory)
    })
  })
  const sessionRunning = createSessionRunning(
    () => sessionStore.session_status[props.session.id],
    () => sessionStore.message[props.session.id],
  )
  const isWorking = createMemo(() => {
    if (hasPermissions()) return false
    return sessionRunning()
  })

  const tint = createMemo(() => messageAgentColor(sessionStore.message[props.session.id], sessionStore.agent))
  const tooltip = createMemo(() => props.showTooltip ?? false)
  const currentChild = createMemo(() => {
    if (!props.showChild) return
    return childSessionOnPath(sessionStore.session, props.session.id, params.id)
  })

  const isPinned = createMemo(() => props.pinned?.(props.session) ?? false)
  const statusGlyph = () => {
    if (isWorking()) return <Spinner class="size-[14px]" style={{ color: tint() ?? "var(--icon-interactive-base)" }} />
    if (hasPermissions()) return <div class="size-1.5 rounded-full bg-surface-warning-strong" />
    if (hasError()) return <div class="size-1.5 rounded-full bg-text-diff-delete-base" />
    if (unseenCount() > 0) return <div class="size-1.5 rounded-full bg-text-interactive-base" />
    if (isPinned()) return <Icon name="pin" size="small" class="text-text-weak" />
    return null
  }
  const statusTime = () => (statusGlyph() ? undefined : props.timeText?.(props.session))

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
      dense={props.dense}
      warmPress={() => warm(2, "high")}
      warmFocus={() => warm(2, "high")}
      titleContent={props.titleContent?.({ session: props.session, title: () => sessionTitle(props.session.title) ?? "" })}
    />
  )

  return (
    <>
      <div
        data-session-id={props.session.id}
        class="group/session relative w-full min-w-0 rounded-md cursor-default pr-2 transition-colors hover:bg-surface-raised-base-hover [&:has(:focus-visible)]:bg-surface-raised-base-hover has-[[data-expanded]]:bg-surface-raised-base-hover has-[.active]:bg-surface-base-active"
        style={{ "padding-left": `${8 + (props.level ?? 0) * 16}px` }}
      >
        <div class="flex min-w-0 items-center gap-1">
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
            <div class="relative shrink-0 flex items-center justify-end h-5 min-w-5">
              {/* default glyph (running / permission / error / unread / pinned) — 20×20 box matches dropdown trigger; fades on hover */}
              <Show when={statusGlyph()}>
                <div class="pointer-events-none size-5 flex items-center justify-center transition-opacity group-hover/session:opacity-0 group-focus-within/session:opacity-0">
                  {statusGlyph()}
                </div>
              </Show>
              {/* fallback time text — free width, fades on hover */}
              <Show when={statusTime()}>
                {(time) => (
                  <span class="pointer-events-none text-12-regular text-text-weaker transition-opacity group-hover/session:opacity-0 group-focus-within/session:opacity-0">
                    {time()}
                  </span>
                )}
              </Show>
              {/* hover/focus action — overlays status icon */}
              <div class="absolute inset-y-0 right-0 flex items-center justify-end opacity-0 pointer-events-none transition-opacity group-hover/session:opacity-100 group-hover/session:pointer-events-auto group-focus-within/session:opacity-100 group-focus-within/session:pointer-events-auto">
                <Show when={props.actionSlot}>{props.actionSlot?.(props.session)}</Show>
              </div>
            </div>
          </Show>
        </div>
      </div>
      <Show when={currentChild()}>
        {(child) => (
          <div class="w-full">
            <SessionItem {...props} session={child()} level={(props.level ?? 0) + 1} />
          </div>
        )}
      </Show>
    </>
  )
}

export const NewSessionItem = (props: {
  slug: string
  dense?: boolean
}): JSX.Element => {
  const language = useLanguage()
  const label = language.t("command.session.new")
  const item = (
    <A
      href={`/${props.slug}/session`}
      end
      class={`flex items-center gap-2 min-w-0 w-full text-left focus:outline-none leading-[1.4] ${props.dense ? "py-1" : "py-[5px]"}`}
    >
      <div data-leading-slot class="shrink-0 w-4 h-4 flex items-center">
        <Icon name="new-session" size="small" class="text-icon-weak" />
      </div>
      <span class="text-13-regular text-text-base [.active_&]:text-text-strong min-w-0 flex-1 truncate">{label}</span>
    </A>
  )

  return (
    <div class="group/session relative w-full min-w-0 rounded-md cursor-default transition-colors pl-2 pr-2 hover:bg-surface-raised-base-hover [&:has(:focus-visible)]:bg-surface-raised-base-hover has-[.active]:bg-surface-base-active">
      {item}
    </div>
  )
}

export const SessionSkeleton = (props: { count?: number }): JSX.Element => {
  const items = Array.from({ length: props.count ?? 4 }, (_, index) => index)
  return (
    <div class="flex flex-col gap-0.5">
      <For each={items}>
        {() => <div class="h-8 w-full rounded-md bg-surface-raised-base opacity-60 animate-pulse" />}
      </For>
    </div>
  )
}
