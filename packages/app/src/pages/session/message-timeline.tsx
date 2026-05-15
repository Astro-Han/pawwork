import { For, createEffect, createMemo, on, onCleanup, onMount, Show, Index, type JSX, createSignal } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useNavigate } from "@solidjs/router"
import { useMutation } from "@tanstack/solid-query"
import { Button } from "@opencode-ai/ui/button"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { DropdownMenu } from "@opencode-ai/ui/dropdown-menu"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Spinner } from "@opencode-ai/ui/spinner"
import { SessionTurn } from "@opencode-ai/ui/session-turn"
import { ScrollView, type ScrollViewScrollIntent } from "@opencode-ai/ui/scroll-view"
import type { AssistantMessage, Message as MessageType, Part, TextPart, UserMessage } from "@opencode-ai/sdk/v2"
import { showToast } from "@opencode-ai/ui/toast"
import { Binary } from "@opencode-ai/util/binary"
import { getFilename } from "@opencode-ai/util/path"
import { shouldMarkBoundaryGesture, normalizeWheelDelta } from "@/pages/session/message-gesture"
import { collectTimelineScrollMetrics } from "@/pages/session/session-timeline-scroll-anchors"
import {
  classifyTimelineScrollGesture,
  type TimelineScrollControllerResult,
  type TimelineScrollIntent,
  type TimelineScrollMetrics,
  type TimelineScrollObservation,
} from "@/pages/session/session-timeline-scroll-controller"
import { taskDescription } from "@/pages/session/task-description"
import { buildTurnMessagesByUserID, emptyAssistantMessages } from "@/pages/session/session-messages"
import {
  turnFetchSignature,
  turnFetchTargets,
  type TurnFetchAssistantLite,
  type TurnFetchInput,
} from "@/pages/session/turn-change-fetch"
import { createSessionRunning } from "@/pages/session/session-running-state"
import { SessionContextUsage } from "@/components/session-context-usage"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useSessionRouteKey } from "@/pages/session/session-layout"
import { usePlatform } from "@/context/platform"
import { emitRendererDiagnostic } from "@/context/renderer-diagnostics"
import { useServer } from "@/context/server"
import { useSettings } from "@/context/settings"
import { useSDK } from "@/context/sdk"
import { useShellSurface } from "@/context/shell-surface"
import { useSync } from "@/context/sync"
import { messageAgentColor } from "@/utils/agent"
import { sessionTitle } from "@/utils/session-title"
import { parseCommentNote, readCommentMetadata } from "@/utils/comment-note"
import { makeTimer } from "@solid-primitives/timer"
import { webSearchRecoveryToast } from "./websearch-toasts"

type MessageComment = {
  path: string
  comment: string
  selection?: {
    startLine: number
    endLine: number
  }
}

function isWebSearchToolPart(part: Part): part is Extract<Part, { type: "tool" }> {
  return part.type === "tool" && part.tool === "websearch"
}

function isPendingWebSearchToolPart(part: Part) {
  return isWebSearchToolPart(part) && (part.state.status === "pending" || part.state.status === "running")
}

const emptyMessages: MessageType[] = []
const idle = { type: "idle" as const }
type UserActions = {
  fork?: (input: { sessionID: string; messageID: string }) => Promise<void> | void
  revert?: (input: { sessionID: string; messageID: string }) => Promise<void> | void
}

type TurnChangeDisplay = {
  sessionID: string
  turnID: string
  messageID: string
  undoAvailable: boolean
  redoAvailable: boolean
  truncated?: boolean
  omittedCount?: number
  skippedCount?: number
  files: Array<{
    path: string
    openPath?: string
    status: "added" | "modified" | "deleted"
    additions?: number
    deletions?: number
    patch?: string
    sensitive?: boolean
    binary?: boolean
    large?: boolean
    restoreAvailable?: boolean
    expandable: boolean
  }>
}

const messageComments = (parts: Part[]): MessageComment[] =>
  parts.flatMap((part) => {
    if (part.type !== "text" || !(part as TextPart).synthetic) return []
    const next = readCommentMetadata(part.metadata) ?? parseCommentNote(part.text)
    if (!next) return []
    return [
      {
        path: next.path,
        comment: next.comment,
        selection: next.selection
          ? {
              startLine: next.selection.startLine,
              endLine: next.selection.endLine,
            }
          : undefined,
      },
    ]
  })

export { taskDescription }

const boundaryTarget = (root: HTMLElement, target: EventTarget | null) => {
  const current = target instanceof Element ? target : undefined
  const nested = current?.closest("[data-scrollable]")
  if (!nested || nested === root) return root
  if (!(nested instanceof HTMLElement)) return root
  return nested
}

const boundaryGesture = (input: {
  root: HTMLDivElement
  target: EventTarget | null
  delta: number
}) => {
  const target = boundaryTarget(input.root, input.target)
  if (target === input.root) return { nestedScrollable: false, atNestedBoundary: true }
  return {
    nestedScrollable: true,
    atNestedBoundary: shouldMarkBoundaryGesture({
      delta: input.delta,
      scrollTop: target.scrollTop,
      scrollHeight: target.scrollHeight,
      clientHeight: target.clientHeight,
    }),
  }
}

const markBoundaryGesture = (input: {
  root: HTMLDivElement
  target: EventTarget | null
  delta: number
  onMarkScrollGesture: (target?: EventTarget | null) => void
}) => {
  const boundary = boundaryGesture(input)
  if (!boundary.nestedScrollable || boundary.atNestedBoundary) {
    input.onMarkScrollGesture(input.root)
  }
}

const scrollViewMetricsToTimelineMetrics = (metrics: {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}): TimelineScrollMetrics => {
  const max = Math.max(0, metrics.scrollHeight - metrics.clientHeight)
  const distanceFromBottom = Math.max(0, max - metrics.scrollTop)
  return {
    scrollTop: metrics.scrollTop,
    scrollHeight: metrics.scrollHeight,
    clientHeight: metrics.clientHeight,
    distanceFromTop: metrics.scrollTop,
    distanceFromBottom,
    nearTop: metrics.scrollTop <= 12,
    nearBottom: distanceFromBottom <= 2,
  }
}

const scrollViewIntentToTimelineIntent = (intent: ScrollViewScrollIntent): TimelineScrollIntent => {
  if (intent.type === "keyboard_scroll") {
    return { type: "keyboard_scroll", key: intent.key, source: "scroll_view" }
  }
  return {
    type: intent.type,
    source: "scroll_view",
    metrics: scrollViewMetricsToTimelineMetrics(intent.metrics),
  }
}

const shouldMarkLegacyScrollIntent = (intent: ScrollViewScrollIntent) => {
  if (intent.type === "keyboard_scroll") return true
  return intent.type === "scrollbar_drag_start"
}

type StageConfig = {
  init: number
  batch: number
}

type TimelineStageInput = {
  sessionKey: () => string
  turnStart: () => number
  messages: () => UserMessage[]
  config: StageConfig
}

/**
 * Defer-mounts small timeline windows so revealing older turns does not
 * block first paint with a large DOM mount.
 *
 * Once staging completes for a session it never re-stages — backfill and
 * new messages render immediately.
 */
function createTimelineStaging(input: TimelineStageInput) {
  const [state, setState] = createStore({
    activeSession: "",
    completedSession: "",
    count: 0,
  })

  const stagedCount = createMemo(() => {
    const total = input.messages().length
    if (input.turnStart() <= 0) return total
    if (state.completedSession === input.sessionKey()) return total
    const init = Math.min(total, input.config.init)
    if (state.count <= init) return init
    if (state.count >= total) return total
    return state.count
  })

  const stagedUserMessages = createMemo(() => {
    const list = input.messages()
    const count = stagedCount()
    if (count >= list.length) return list
    return list.slice(Math.max(0, list.length - count))
  })

  let frame: number | undefined
  const cancel = () => {
    if (frame === undefined) return
    cancelAnimationFrame(frame)
    frame = undefined
  }

  createEffect(
    on(
      () => [input.sessionKey(), input.turnStart() > 0, input.messages().length] as const,
      ([sessionKey, isWindowed, total]) => {
        cancel()
        const shouldStage =
          isWindowed &&
          total > input.config.init &&
          state.completedSession !== sessionKey &&
          state.activeSession !== sessionKey
        if (!shouldStage) {
          setState({ activeSession: "", count: total })
          return
        }

        let count = Math.min(total, input.config.init)
        setState({ activeSession: sessionKey, count })

        const step = () => {
          if (input.sessionKey() !== sessionKey) {
            frame = undefined
            return
          }
          const currentTotal = input.messages().length
          count = Math.min(currentTotal, count + input.config.batch)
          setState("count", count)
          if (count >= currentTotal) {
            setState({ completedSession: sessionKey, activeSession: "" })
            frame = undefined
            return
          }
          frame = requestAnimationFrame(step)
        }
        frame = requestAnimationFrame(step)
      },
    ),
  )

  const isStaging = createMemo(() => {
    const key = input.sessionKey()
    return state.activeSession === key && state.completedSession !== key
  })

  onCleanup(cancel)
  return { messages: stagedUserMessages, isStaging }
}

export function MessageTimeline(props: {
  sessionID: string
  sessionKey: string
  sessionMessages: MessageType[]
  mobileChanges: boolean
  mobileFallback: JSX.Element
  actions?: UserActions
  scroll: { overflow: boolean; bottom: boolean; jump: boolean }
  onResumeScroll: () => void
  setScrollRef: (el: HTMLDivElement | undefined) => void
  onScheduleScrollState: (el: HTMLDivElement) => void
  onAutoScrollHandleScroll: () => void
  onMarkScrollGesture: (target?: EventTarget | null) => void
  hasScrollGesture: () => boolean
  onUserScroll: () => void
  onTurnBackfillScroll: () => void
  onAutoScrollInteraction: (event: MouseEvent) => void
  onTimelineScrollIntent: (intent: TimelineScrollIntent) => void
  onTimelineScrollObservation: (observation: TimelineScrollObservation) => TimelineScrollControllerResult
  centered: boolean
  setContentRef: (el: HTMLDivElement) => void
  turnStart: number
  historyMore: boolean
  historyLoading: boolean
  onLoadEarlier: () => void
  renderedUserMessages: UserMessage[]
  anchor: (id: string) => string
}) {
  let touchGesture: number | undefined
  let scrollSampleFrame: number | undefined
  let viewportRef: HTMLDivElement | undefined
  let mounted = true
  let pendingScrollSample:
    | {
        scroll_top: number
        scroll_height: number
        client_height: number
        distance_from_bottom: number
        user_scrolled: boolean
        jump_button_visible: boolean
      }
    | undefined

  const navigate = useNavigate()
  const sdk = useSDK()
  const sync = useSync()
  const settings = useSettings()
  const dialog = useDialog()
  const language = useLanguage()
  const shellSurface = useShellSurface()
  const { params } = useSessionRouteKey()
  const platform = usePlatform()
  const server = useServer()
  onCleanup(() => {
    mounted = false
    if (scrollSampleFrame !== undefined) cancelAnimationFrame(scrollSampleFrame)
  })
  // Export hits the embedded sidecar via main-process IPC. When the user has switched the
  // active server to a remote HTTP/SSH target, the sidecar holds different data than the UI;
  // hide the action rather than ship a misleading export.
  const exportAvailable = createMemo(() => !!platform.exportSession && server.current?.type === "sidecar")

  const rendered = createMemo(() => props.renderedUserMessages.map((message) => message.id))
  const visibleRange = createMemo(() => {
    const ids = rendered()
    const first = ids[0]
    const last = ids.at(-1)
    return {
      rendered_count: ids.length,
      visible_first_message_id: first,
      visible_last_message_id: last,
      signature: `${ids.length}:${first ?? ""}:${last ?? ""}`,
    }
  })
  const visibleRangeData = () => {
    const range = visibleRange()
    return {
      rendered_count: range.rendered_count,
      visible_first_message_id: range.visible_first_message_id,
      visible_last_message_id: range.visible_last_message_id,
    }
  }
  const sessionKey = createMemo(() => props.sessionKey)
  const sessionID = createMemo(() => props.sessionID)
  const sessionMessages = createMemo(() => props.sessionMessages)
  const turnMessagesByUserID = createMemo(() => buildTurnMessagesByUserID(sessionMessages()))
  const webSearchToastSurfaced = new Set<string>()
  const webSearchPartCursor = new Map<string, number>()
  const webSearchPendingParts = new Map<string, Set<string>>()
  const [turnChanges, setTurnChanges] = createStore<Record<string, TurnChangeDisplay | null>>({})
  const fetchedTurnChanges = new Set<string>()
  const turnChangeRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const cancelTurnChangeRetries = () => {
    for (const timer of turnChangeRetryTimers.values()) clearTimeout(timer)
    turnChangeRetryTimers.clear()
  }
  onCleanup(cancelTurnChangeRetries)
  createEffect(
    on(
      sessionID,
      () => {
        cancelTurnChangeRetries()
        fetchedTurnChanges.clear()
      },
      { defer: true },
    ),
  )

  const authHeaders = () => {
    const current = server.current
    if (!current?.http.password) return {} as Record<string, string>
    return {
      Authorization: `Basic ${btoa(`${current.http.username ?? "opencode"}:${current.http.password}`)}`,
    }
  }

  const blockedDescription = (body: any) => {
    const base =
      body?.reason === "conflict"
        ? language.t("session.turnChange.blocked.conflict")
        : body?.reason === "unsupported_size"
          ? language.t("session.turnChange.blocked.unsupportedSize")
          : body?.reason === "permission_denied"
            ? language.t("session.turnChange.blocked.permissionDenied")
            : body?.reason === "rollback_failed"
              ? language.t("session.turnChange.blocked.rollbackFailed")
              : language.t("session.turnChange.blocked.generic")
    const files = Array.isArray(body?.files)
      ? body.files.filter((file: any) => typeof file?.path === "string").map((file: any) => file.path as string)
      : []
    if (!files.length) return base
    const visible = files.slice(0, 3).join(", ")
    const rest = files.length > 3 ? language.t("session.turnChange.blocked.more", { count: files.length - 3 }) : ""
    return `${base} ${language.t("session.turnChange.blocked.files", { files: `${visible}${rest}` })}`
  }

  const turnChangeFetch = async (
    userMessageID: string,
    action?: "undo" | "redo",
    options?: { force?: boolean },
  ): Promise<TurnChangeDisplay | undefined> => {
    const current = server.current
    const id = sessionID()
    if (!current || !id) return
    const url = `${current.http.url}/session/${id}/turn/${userMessageID}/changes${action ? `/${action}` : ""}`
    let res: Response
    try {
      res = await fetch(url, {
        method: action ? "POST" : "GET",
        headers: {
          ...authHeaders(),
          ...(action ? { "Content-Type": "application/json" } : {}),
        },
        ...(action ? { body: JSON.stringify({ force: !!options?.force }) } : {}),
      })
    } catch (err) {
      if (action) {
        showToast({
          title:
            action === "undo"
              ? language.t("session.turnChange.undoBlocked")
              : language.t("session.turnChange.redoBlocked"),
          description: language.t("session.turnChange.blocked.generic"),
          variant: "error",
        })
      }
      return turnChanges[userMessageID] ?? undefined
    }
    if (!res.ok) {
      if (action) {
        showToast({
          title:
            action === "undo"
              ? language.t("session.turnChange.undoBlocked")
              : language.t("session.turnChange.redoBlocked"),
          description: language.t("session.turnChange.blocked.generic"),
          variant: "error",
        })
      }
      return turnChanges[userMessageID] ?? undefined
    }
    let body: any
    try {
      body = await res.json()
    } catch {
      if (action) {
        showToast({
          title:
            action === "undo"
              ? language.t("session.turnChange.undoBlocked")
              : language.t("session.turnChange.redoBlocked"),
          description: language.t("session.turnChange.blocked.generic"),
          variant: "error",
        })
      }
      return turnChanges[userMessageID] ?? undefined
    }
    if (!action) {
      setTurnChanges(userMessageID, body ?? null)
      return body ?? undefined
    }
    if (body?.status === "applied") {
      const rawDisplay: TurnChangeDisplay | null = body.display ?? null
      let display: TurnChangeDisplay | null = rawDisplay
      if (rawDisplay && Array.isArray(body.skipped) && body.skipped.length) {
        const skippedCount = body.skipped.reduce(
          (sum: number, item: any) => sum + (Array.isArray(item?.files) ? item.files.length : 0),
          0,
        )
        if (skippedCount > 0) display = { ...rawDisplay, skippedCount }
      }
      setTurnChanges(userMessageID, display)
      return display ?? undefined
    }
    if (action && body?.status === "blocked" && body.reason === "conflict" && !options?.force) {
      const conflictPaths = Array.isArray(body.files)
        ? (body.files as Array<{ path?: unknown }>)
            .map((file) => (typeof file?.path === "string" ? file.path : ""))
            .filter((path) => path.length > 0)
        : []
      return await new Promise<TurnChangeDisplay | undefined>((resolve) => {
        let settled = false
        const finish = (value: TurnChangeDisplay | undefined) => {
          if (settled) return
          settled = true
          resolve(value)
        }
        dialog.show(
          () => (
            <Dialog
              title={language.t("ui.sessionTurn.turnChanges.confirmTitle")}
              description={language.t("ui.sessionTurn.turnChanges.confirmDescription")}
              size="normal"
              fit
            >
              <div class="flex flex-col gap-4 px-5 pb-5 pt-2">
                <Show when={conflictPaths.length > 0}>
                  <div class="flex flex-col rounded-md border border-border-base bg-surface-base max-h-44 overflow-auto">
                    <For each={conflictPaths.slice(0, 6)}>
                      {(item) => (
                        <div
                          class="px-3 py-1.5 text-13-regular text-fg-strong font-mono truncate"
                          title={item}
                        >
                          {item}
                        </div>
                      )}
                    </For>
                    <Show when={conflictPaths.length > 6}>
                      <div class="px-3 py-1.5 text-12-regular text-fg-weak border-t border-border-base">
                        {language.t("ui.sessionTurn.turnChanges.confirmListMore", {
                          count: conflictPaths.length - 6,
                        })}
                      </div>
                    </Show>
                  </div>
                </Show>
                <div class="flex justify-end gap-2">
                  <Button
                    variant="ghost"
                    onClick={() => {
                      dialog.close()
                      finish(undefined)
                    }}
                  >
                    {language.t("ui.sessionTurn.turnChanges.confirmCancel")}
                  </Button>
                  <Button
                    variant="primary"
                    onClick={async () => {
                      dialog.close()
                      const next = await turnChangeFetch(userMessageID, action, { force: true })
                      finish(next)
                    }}
                  >
                    {language.t("ui.sessionTurn.turnChanges.confirmApply")}
                  </Button>
                </div>
              </div>
            </Dialog>
          ),
          () => finish(undefined),
        )
      })
    }
    showToast({
      title:
        action === "undo"
          ? language.t("session.turnChange.undoBlocked")
          : language.t("session.turnChange.redoBlocked"),
      description: blockedDescription(body),
      variant: "error",
    })
    return turnChanges[userMessageID] ?? undefined
  }

  const turnFetchInput = (): TurnFetchInput | null => {
    const id = sessionID()
    if (!id) return null
    const assistants: TurnFetchAssistantLite[] = []
    for (const message of sessionMessages()) {
      if (message.role !== "assistant") continue
      assistants.push({
        id: message.id,
        parentID: message.parentID,
        completed: message.time.completed,
      })
    }
    return { sessionID: id, assistants }
  }

  createEffect(
    on(
      () => {
        const input = turnFetchInput()
        return input ? turnFetchSignature(input) : ""
      },
      () => {
        const input = turnFetchInput()
        if (!input) return
        for (const target of turnFetchTargets(input)) {
          if (fetchedTurnChanges.has(target.key)) continue
          fetchedTurnChanges.add(target.key)
          void turnChangeFetch(target.userMessageID)
            .then((display) => {
              if (display) return
              if (turnChangeRetryTimers.has(target.key)) return
              const timer = setTimeout(() => {
                turnChangeRetryTimers.delete(target.key)
                void turnChangeFetch(target.userMessageID).catch(() => undefined)
              }, 500)
              turnChangeRetryTimers.set(target.key, timer)
            })
            .catch(() => {
              fetchedTurnChanges.delete(target.key)
              setTurnChanges(target.userMessageID, null)
            })
        }
      },
    ),
  )

  onMount(() => {
    void emitRendererDiagnostic({
      name: "session.timeline.mount",
      route_session_id: params.id,
      visible_session_id: props.sessionID,
      timeline_session_id: props.sessionID,
      data: visibleRangeData(),
    })
  })

  onCleanup(() => {
    void emitRendererDiagnostic({
      name: "session.timeline.unmount",
      route_session_id: params.id,
      visible_session_id: props.sessionID,
      timeline_session_id: props.sessionID,
      data: visibleRangeData(),
    })
  })

  createEffect(
    on(
      () => visibleRange().signature,
      () => {
        void emitRendererDiagnostic({
          name: "session.timeline.visible",
          route_session_id: params.id,
          visible_session_id: props.sessionID,
          timeline_session_id: props.sessionID,
          data: visibleRangeData(),
        })
      },
    ),
  )
  let webSearchToastSessionID: string | undefined

  createEffect(() => {
    const id = sessionID()
    if (id !== webSearchToastSessionID) {
      webSearchToastSessionID = id
      webSearchToastSurfaced.clear()
      webSearchPartCursor.clear()
      webSearchPendingParts.clear()
    }
    for (const message of sessionMessages()) {
      const parts = sync.data.part[message.id] ?? []
      const start = webSearchPartCursor.get(message.id) ?? 0
      const pending = webSearchPendingParts.get(message.id) ?? new Set<string>()
      const candidates = [...parts.slice(start), ...parts.slice(0, start).filter((part) => pending.has(part.id))]
      for (const part of candidates) {
        if (isPendingWebSearchToolPart(part)) pending.add(part.id)
        else pending.delete(part.id)
        const toast = webSearchRecoveryToast(part, { surfaced: webSearchToastSurfaced })
        if (!toast) continue
        showToast({
          title: language.t(toast.titleKey),
          description: language.t(toast.descriptionKey),
          variant: "error",
          actions: [
            {
              label: language.t(toast.actionKey),
              onClick: () => shellSurface.openSettings(),
            },
          ],
        })
      }
      webSearchPartCursor.set(message.id, parts.length)
      if (pending.size > 0) webSearchPendingParts.set(message.id, pending)
      else webSearchPendingParts.delete(message.id)
    }
  })
  const pending = createMemo(() => {
    const messages = sessionMessages() ?? emptyMessages
    return messages.findLast(
      (item): item is AssistantMessage => item.role === "assistant" && typeof item.time.completed !== "number",
    )
  })
  const sessionStatus = createMemo(() => {
    const id = sessionID()
    if (!id) return idle
    return sync.data.session_status[id] ?? idle
  })
  const working = createSessionRunning(sessionStatus, sessionMessages)
  const tint = createMemo(() => messageAgentColor(sessionMessages(), sync.data.agent))

  const [timeoutDone, setTimeoutDone] = createSignal(true)

  const workingStatus = createMemo<"hidden" | "showing" | "hiding">((prev) => {
    if (working()) return "showing"
    if (prev === "showing" || !timeoutDone()) return "hiding"
    return "hidden"
  })

  createEffect(() => {
    if (workingStatus() !== "hiding") return

    setTimeoutDone(false)
    makeTimer(() => setTimeoutDone(true), 260, setTimeout)
  })

  const activeMessageID = createMemo(() => {
    const parentID = working() ? pending()?.parentID : undefined
    if (parentID) {
      const messages = sessionMessages()
      const result = Binary.search(messages, parentID, (message) => message.id)
      const message = result.found ? messages[result.index] : messages.find((item) => item.id === parentID)
      if (message && message.role === "user") return message.id
    }

    const status = sessionStatus() ?? idle
    if (status.type !== "idle") {
      const messages = sessionMessages()
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") return messages[i].id
      }
    }

    return undefined
  })
  const info = createMemo(() => {
    const id = sessionID()
    if (!id) return
    return sync.session.get(id)
  })
  const titleValue = createMemo(() => info()?.title)
  const titleLabel = createMemo(() => sessionTitle(titleValue()))
  const parentID = createMemo(() => info()?.parentID)
  const parent = createMemo(() => {
    const id = parentID()
    if (!id) return
    return sync.session.get(id)
  })
  const parentMessages = createMemo(() => {
    const id = parentID()
    if (!id) return emptyMessages
    return sync.data.message[id] ?? emptyMessages
  })
  const parentTitle = createMemo(() => sessionTitle(parent()?.title) ?? language.t("command.session.new"))
  const childTaskDescription = createMemo(() => {
    const id = sessionID()
    if (!id) return
    return parentMessages()
      .flatMap((message) => sync.data.part[message.id] ?? [])
      .map((part) => taskDescription(part, id))
      .findLast((value): value is string => !!value)
  })
  const childTitle = createMemo(() => {
    if (!parentID()) return titleLabel() ?? ""
    if (childTaskDescription()) return childTaskDescription()
    const value = titleLabel()?.replace(/\s+\(@[^)]+ subagent\)$/, "")
    if (value) return value
    return language.t("command.session.new")
  })
  const showHeader = createMemo(() => !!(titleValue() || parentID()))
  // Match the initial window cap so session switches do not reveal the window in partial batches.
  const stageCfg = { init: 10, batch: 3 }
  const staging = createTimelineStaging({
    sessionKey: () => props.sessionKey,
    turnStart: () => props.turnStart,
    messages: () => props.renderedUserMessages,
    config: stageCfg,
  })

  const [title, setTitle] = createStore({
    draft: "",
    editing: false,
    menuOpen: false,
    pendingRename: false,
  })
  let titleRef: HTMLInputElement | undefined

  let more: HTMLButtonElement | undefined

  const errorMessage = (err: unknown) => {
    if (err && typeof err === "object" && "data" in err) {
      const data = (err as { data?: { message?: string } }).data
      if (data?.message) return data.message
    }
    if (err instanceof Error) return err.message
    return language.t("common.requestFailed")
  }

  const titleMutation = useMutation(() => ({
    mutationFn: (input: { id: string; title: string }) =>
      sdk.client.session.update({ sessionID: input.id, title: input.title }),
    onSuccess: (_, input) => {
      sync.set(
        produce((draft) => {
          const index = draft.session.findIndex((s) => s.id === input.id)
          if (index !== -1) draft.session[index].title = input.title
        }),
      )
      setTitle("editing", false)
    },
    onError: (err) => {
      showToast({
        title: language.t("common.requestFailed"),
        description: errorMessage(err),
      })
    },
  }))

  const onExport = async () => {
    const id = sessionID()
    if (!id || !platform.exportSession) return

    // Build a slug-based default filename. Falls back to id suffix if slug is missing.
    const slugSource = info()?.slug ?? id
    // Allow Unicode letters/numbers (CJK titles work) but strip filesystem-hostile chars.
    // If sanitization produces an empty/dash-only string, fall back to the id suffix.
    const sanitized = slugSource.replace(/[\\/:*?"<>|]/g, "-").slice(0, 32)
    const slug = /[\p{L}\p{N}]/u.test(sanitized) ? sanitized : id.slice(-8)
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").replace(/\..+$/, "")
    const defaultName = `pawwork-session-${slug}-${stamp}.json`

    let result: { ok: true; path: string } | { ok: false; error: string }
    try {
      result = await platform.exportSession(id, sdk.directory, defaultName, language.t("session.export.action.export"))
    } catch (err) {
      showToast({
        title: language.t("session.export.error.failed"),
        description: errorMessage(err),
        variant: "error",
      })
      return
    }
    if (!result.ok) {
      if (result.error === "cancelled") return
      showToast({
        title: language.t("session.export.error.failed"),
        description: result.error,
        variant: "error",
      })
      return
    }
    showToast({
      title: language.t("session.export.success"),
      description: result.path,
    })
  }

  createEffect(
    on(
      sessionKey,
      () =>
        setTitle({
          draft: "",
          editing: false,
          menuOpen: false,
          pendingRename: false,
        }),
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => [parentID(), childTaskDescription()] as const,
      ([id, description]) => {
        if (!id || description) return
        if (sync.data.message[id] !== undefined) return
        void sync.session.sync(id)
      },
      { defer: true },
    ),
  )

  const openTitleEditor = () => {
    if (!sessionID() || parentID()) return
    setTitle({ editing: true, draft: titleLabel() ?? "" })
    requestAnimationFrame(() => {
      titleRef?.focus()
      titleRef?.select()
    })
  }

  const closeTitleEditor = () => {
    if (titleMutation.isPending) return
    setTitle("editing", false)
  }

  const saveTitleEditor = () => {
    const id = sessionID()
    if (!id) return
    if (titleMutation.isPending) return

    const next = title.draft.trim()
    if (!next || next === (titleLabel() ?? "")) {
      setTitle("editing", false)
      return
    }

    titleMutation.mutate({ id, title: next })
  }

  const navigateParent = () => {
    const id = parentID()
    if (!id) return
    navigate(`/${params.dir}/session/${id}`)
  }

  return (
    <Show
      when={!props.mobileChanges}
      fallback={<div class="relative h-full overflow-hidden">{props.mobileFallback}</div>}
    >
      <div class="relative w-full h-full min-w-0">
        <div
          class="absolute left-1/2 -translate-x-1/2 bottom-[calc(var(--composer-dock-height,0px)+2.5rem)] z-[60] pointer-events-none transition-[opacity,transform] duration-200 ease-out"
          classList={{
            "opacity-100 translate-y-0 scale-100": props.scroll.overflow && props.scroll.jump && !staging.isStaging(),
            "opacity-0 translate-y-2 scale-95 pointer-events-none":
              !props.scroll.overflow || !props.scroll.jump || staging.isStaging(),
          }}
        >
          <button
            type="button"
            class="pointer-events-auto w-[30px] h-[30px] rounded-full border border-border-weaker bg-surface-raised flex items-center justify-center cursor-pointer p-0 transition-colors hover:bg-[linear-gradient(rgba(0,0,0,0.04),rgba(0,0,0,0.04))] dark:hover:bg-[linear-gradient(rgba(255,255,255,0.04),rgba(255,255,255,0.04))]"
            style={{ "box-shadow": "var(--shadow-floating)" }}
            onClick={props.onResumeScroll}
            aria-label={language.t("session.messages.jumpToLatest")}
          >
            <Icon name="chevron-down" />
          </button>
        </div>
        <ScrollView
          viewportRef={(el) => {
            viewportRef = el
            props.setScrollRef(el)
          }}
          onScrollIntent={(intent) => {
            if (shouldMarkLegacyScrollIntent(intent)) props.onMarkScrollGesture(viewportRef)
            props.onTimelineScrollIntent(scrollViewIntentToTimelineIntent(intent))
          }}
          onWheel={(e) => {
            const root = e.currentTarget
            const delta = normalizeWheelDelta({
              deltaY: e.deltaY,
              deltaMode: e.deltaMode,
              rootHeight: root.clientHeight,
            })
            if (!delta) return
            const boundary = boundaryGesture({ root, target: e.target, delta })
            const gesture = classifyTimelineScrollGesture({
              deltaY: delta,
              viewportHeight: root.clientHeight,
              nestedScrollable: boundary.nestedScrollable,
              atNestedBoundary: boundary.atNestedBoundary,
            })
            props.onTimelineScrollIntent({
              type: "wheel_scroll",
              source: "timeline",
              ...gesture,
            })
            markBoundaryGesture({ root, target: e.target, delta, onMarkScrollGesture: props.onMarkScrollGesture })
          }}
          onTouchStart={(e) => {
            touchGesture = e.touches[0]?.clientY
          }}
          onTouchMove={(e) => {
            const next = e.touches[0]?.clientY
            const prev = touchGesture
            touchGesture = next
            if (next === undefined || prev === undefined) return

            const delta = prev - next
            if (!delta) return

            const root = e.currentTarget
            const boundary = boundaryGesture({ root, target: e.target, delta })
            const gesture = classifyTimelineScrollGesture({
              deltaY: delta,
              viewportHeight: root.clientHeight,
              nestedScrollable: boundary.nestedScrollable,
              atNestedBoundary: boundary.atNestedBoundary,
            })
            props.onTimelineScrollIntent({
              type: "touch_scroll",
              source: "timeline",
              ...gesture,
            })
            markBoundaryGesture({ root, target: e.target, delta, onMarkScrollGesture: props.onMarkScrollGesture })
          }}
          onTouchEnd={() => {
            touchGesture = undefined
          }}
          onTouchCancel={() => {
            touchGesture = undefined
          }}
          onPointerDown={(e) => {
            if (e.target !== e.currentTarget) return
            props.onMarkScrollGesture(e.currentTarget)
          }}
          onScroll={(e) => {
            const el = e.currentTarget
            const metrics = collectTimelineScrollMetrics(el)
            const controllerResult = props.onTimelineScrollObservation({
              type: "scroll_sample",
              metrics,
            })
            if (!controllerResult.accepted) return
            const max = Math.max(0, el.scrollHeight - el.clientHeight)
            pendingScrollSample = {
              scroll_top: el.scrollTop,
              scroll_height: el.scrollHeight,
              client_height: el.clientHeight,
              distance_from_bottom: Math.max(0, max - el.scrollTop),
              user_scrolled: props.hasScrollGesture(),
              jump_button_visible: props.scroll.overflow && props.scroll.jump && !staging.isStaging(),
            }
            if (scrollSampleFrame === undefined) {
              scrollSampleFrame = requestAnimationFrame(() => {
                scrollSampleFrame = undefined
                if (!mounted) return
                const sample = pendingScrollSample
                pendingScrollSample = undefined
                if (!sample) return
                void emitRendererDiagnostic({
                  name: "session.scroll.sample",
                  route_session_id: params.id,
                  visible_session_id: props.sessionID,
                  timeline_session_id: props.sessionID,
                  data: { ...sample, ...visibleRangeData() },
                }).catch(() => {})
              })
            }
            props.onScheduleScrollState(e.currentTarget)
            props.onTurnBackfillScroll()
            if (!props.hasScrollGesture()) return
            props.onUserScroll()
            props.onAutoScrollHandleScroll()
            props.onMarkScrollGesture(e.currentTarget)
          }}
          onClick={props.onAutoScrollInteraction}
          class="relative min-w-0 w-full h-full"
          style={{
            "--session-title-height": "0px",
            "--sticky-accordion-top": "0px",
          }}
        >
          <div
            ref={props.setContentRef}
            class="min-w-0 w-full"
            style={{
              "padding-top": "1rem",
              "padding-bottom": "calc(var(--composer-dock-height, 0px) + 32px)",
            }}
          >
            <div
              role="log"
              data-component="session-timeline-column"
              data-slot="session-turn-list"
              class="flex flex-col items-start justify-start pb-4 transition-[margin]"
              classList={{
                "w-full": true,
                "md:max-w-[800px] md:mx-auto 2xl:max-w-[1000px]": props.centered,
                "mt-0.5": props.centered,
                "mt-0": !props.centered,
              }}
            >
              <Show when={props.turnStart > 0 || props.historyMore}>
                <div class="w-full flex justify-center">
                  <Button
                    variant="ghost"
                    size="large"
                    class="text-13-medium opacity-50"
                    disabled={props.historyLoading}
                    onClick={props.onLoadEarlier}
                  >
                    {props.historyLoading
                      ? language.t("session.messages.loadingEarlier")
                      : language.t("session.messages.loadEarlier")}
                  </Button>
                </div>
              </Show>
              <For each={rendered()}>
                {(messageID, index) => {
                  const userMessage = createMemo(() => props.renderedUserMessages[index()])
                  const active = createMemo(() => activeMessageID() === messageID)
                  const comments = createMemo(() => messageComments(sync.data.part[messageID] ?? []), [], {
                    equals: (a, b) =>
                      a.length === b.length &&
                      a.every(
                        (c, i) =>
                          c.path === b[i].path &&
                          c.comment === b[i].comment &&
                          c.selection?.startLine === b[i].selection?.startLine &&
                          c.selection?.endLine === b[i].selection?.endLine,
                      ),
                  })
                  const commentCount = createMemo(() => comments().length)
                  return (
                    <div
                      id={props.anchor(messageID)}
                      data-message-id={messageID}
                      classList={{
                        "min-w-0 w-full max-w-full": true,
                        "md:max-w-[800px] 2xl:max-w-[1000px]": props.centered,
                      }}
                      style={{
                        "content-visibility": active() ? undefined : "auto",
                        "contain-intrinsic-size": active() ? undefined : "auto 500px",
                      }}
                    >
                      <Show when={commentCount() > 0}>
                        <div class="w-full px-4 md:px-5 pb-2">
                          <div class="ml-auto max-w-[82%] overflow-x-auto no-scrollbar">
                            <div class="flex w-max min-w-full justify-end gap-2">
                              <Index each={comments()}>
                                {(commentAccessor: () => MessageComment) => {
                                  const comment = createMemo(() => commentAccessor())
                                  return (
                                    <Show when={comment()}>
                                      {(c) => (
                                        <div class="shrink-0 max-w-[260px] rounded-[6px] border border-border-weak bg-bg-base px-2.5 py-2">
                                          <div class="flex items-center gap-1.5 min-w-0 text-13-medium text-fg-strong">
                                            <FileIcon
                                              node={{ path: c().path, type: "file" }}
                                              class="size-3.5 shrink-0"
                                            />
                                            <span class="truncate">{getFilename(c().path)}</span>
                                            <Show when={c().selection}>
                                              {(selection) => (
                                                <span class="shrink-0 text-fg-weak">
                                                  {selection().startLine === selection().endLine
                                                    ? `:${selection().startLine}`
                                                    : `:${selection().startLine}-${selection().endLine}`}
                                                </span>
                                              )}
                                            </Show>
                                          </div>
                                          <div class="pt-1 text-13-regular text-fg-strong whitespace-pre-wrap break-words">
                                            {c().comment}
                                          </div>
                                        </div>
                                      )}
                                    </Show>
                                  )
                                }}
                              </Index>
                            </div>
                          </div>
                        </div>
                      </Show>
                      <SessionTurn
                        sessionID={sessionID() ?? ""}
                        messageID={messageID}
                        message={userMessage()}
                        assistantMessages={turnMessagesByUserID().get(messageID) ?? emptyAssistantMessages}
                        messages={sessionMessages()}
                        actions={props.actions}
                        active={active()}
                        status={active() ? sessionStatus() : undefined}
                        showReasoningSummaries={settings.general.showReasoningSummaries()}
                        shellToolDefaultOpen={settings.general.shellToolPartsExpanded()}
                        editToolDefaultOpen={settings.general.editToolPartsExpanded()}
                        turnChanges={turnChanges}
                        turnChangeActions={{
                          undo: (userMessageID, options) => turnChangeFetch(userMessageID, "undo", options),
                          redo: (userMessageID, options) => turnChangeFetch(userMessageID, "redo", options),
                          openFile: (path) => {
                            void platform.openPath?.(path)
                          },
                          showInFolder: (path) => {
                            void platform.showItemInFolder?.(path)
                          },
                        }}
                        classes={{
                          root: "min-w-0 w-full relative",
                          content: "flex flex-col justify-between !overflow-visible",
                          container: "w-full px-4 md:px-5",
                        }}
                      />
                    </div>
                  )
                }}
              </For>
            </div>
          </div>
        </ScrollView>
      </div>
    </Show>
  )
}
