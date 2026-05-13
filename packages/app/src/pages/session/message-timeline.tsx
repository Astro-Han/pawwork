import { For, createEffect, createMemo, on, onCleanup, onMount, Show, type JSX } from "solid-js"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { JumpToBottom } from "@opencode-ai/ui/session-turn-jump"
import type { AssistantMessage, Message as MessageType, Part, UserMessage } from "@opencode-ai/sdk/v2"
import { Binary } from "@opencode-ai/util/binary"
import { normalizeWheelDelta } from "@/pages/session/message-gesture"
import { collectTimelineScrollMetrics } from "@/pages/session/session-timeline-scroll-anchors"
import {
  classifyTimelineScrollGesture,
  type TimelineScrollControllerResult,
  type TimelineScrollIntent,
  type TimelineScrollObservation,
} from "@/pages/session/session-timeline-scroll-controller"
import { taskDescription } from "@/pages/session/task-description"
import { createSessionRunning } from "@/pages/session/session-running-state"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useSessionRouteKey } from "@/pages/session/session-layout"
import { usePlatform } from "@/context/platform"
import { emitRendererDiagnostic } from "@/context/renderer-diagnostics"
import { useServer } from "@/context/server"
import { useSettings } from "@/context/settings"
import { useShellSurface } from "@/context/shell-surface"
import { useSync } from "@/context/sync"
import { createTimelineStaging } from "@/pages/session/message-timeline-staging"
import {
  boundaryGesture,
  markBoundaryGesture,
  scrollViewIntentToTimelineIntent,
  shouldMarkLegacyScrollIntent,
} from "@/pages/session/message-timeline-scroll"
import { LoadEarlierButton } from "@/pages/session/message-timeline-history-load"
import {
  createTurnChangeFetcher,
  type TurnChangeDisplay,
} from "@/pages/session/message-timeline-turn-changes"
import { TimelineMessage } from "@/pages/session/message-timeline-row"
import { createWebSearchToastWatcher } from "@/pages/session/message-timeline-websearch"

const emptyMessages: MessageType[] = []
const idle = { type: "idle" as const }
type UserActions = {
  fork?: (input: { sessionID: string; messageID: string }) => Promise<void> | void
  revert?: (input: { sessionID: string; messageID: string }) => Promise<void> | void
}

export { taskDescription }
export type { TurnChangeDisplay }

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
  // Turn-change auto-prefetch + imperative undo/redo with conflict dialog
  // owned by ./message-timeline-turn-changes. Pass the server URL + auth
  // builder so the fetcher stays independent of the timeline's other
  // dependencies (sync / settings / etc.).
  const authHeaders = () => {
    const current = server.current
    if (!current?.http.password) return {} as Record<string, string>
    return {
      Authorization: `Basic ${btoa(`${current.http.username ?? "opencode"}:${current.http.password}`)}`,
    }
  }
  const turnChangeFetcher = createTurnChangeFetcher({
    sessionID,
    sessionMessages,
    language,
    dialog,
    authHeaders,
    httpUrl: () => server.current?.http.url,
  })
  const turnChanges = turnChangeFetcher.turnChanges
  const turnChangeFetch = turnChangeFetcher.fetch

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
  createWebSearchToastWatcher({
    sessionID,
    sessionMessages,
    partsByMessageID: (messageID) => sync.data.part[messageID],
    language,
    openSettings: () => shellSurface.openSettings(),
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
  const parentID = createMemo(() => info()?.parentID)
  const parentMessages = createMemo(() => {
    const id = parentID()
    if (!id) return emptyMessages
    return sync.data.message[id] ?? emptyMessages
  })
  const childTaskDescription = createMemo(() => {
    const id = sessionID()
    if (!id) return
    return parentMessages()
      .flatMap((message) => sync.data.part[message.id] ?? [])
      .map((part) => taskDescription(part, id))
      .findLast((value): value is string => !!value)
  })
  // Match the initial window cap so session switches do not reveal the window in partial batches.
  const stageCfg = { init: 10, batch: 3 }
  const staging = createTimelineStaging({
    sessionKey: () => props.sessionKey,
    turnStart: () => props.turnStart,
    messages: () => props.renderedUserMessages,
    config: stageCfg,
  })

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

  return (
    <Show
      when={!props.mobileChanges}
      fallback={<div class="relative h-full overflow-hidden">{props.mobileFallback}</div>}
    >
      <div class="relative w-full h-full min-w-0">
        <div
          class="absolute left-1/2 -translate-x-1/2 bottom-[calc(var(--composer-dock-height,0px)+2.5rem)] z-[60] pointer-events-none transition-[opacity,transform] duration-200 ease-out [&_[data-component=session-turn-jump]]:pointer-events-auto"
          classList={{
            "opacity-100 translate-y-0 scale-100": props.scroll.overflow && props.scroll.jump && !staging.isStaging(),
            "opacity-0 translate-y-2 scale-95":
              !props.scroll.overflow || !props.scroll.jump || staging.isStaging(),
          }}
        >
          <JumpToBottom
            visible={props.scroll.overflow && props.scroll.jump && !staging.isStaging()}
            onClick={props.onResumeScroll}
            label={language.t("session.messages.jumpToLatest")}
          />
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
            // Slice 11b.1 P0 #6 retest — GPT-X RCA: previously
            // `onScheduleScrollState` ran before the auto-scroll
            // handlers had a chance to mark the gesture / clear the
            // bottom-follow lock. With the bottom-follow lock still
            // armed when `scheduleScrollState` ran, the
            // bottomFollowLocked() branch inside `scheduleScrollState`
            // would call `followBottom()` and snap the viewport back
            // to bottom before the gesture path could even update
            // `userScrolled`. Reordering the gesture-driven branch
            // first lets the lock get cancelled and `userScrolled` get
            // set on the same frame, so the schedule call below sees
            // the post-gesture state.
            if (props.hasScrollGesture()) {
              props.onUserScroll()
              props.onAutoScrollHandleScroll()
              props.onMarkScrollGesture(e.currentTarget)
            }
            props.onScheduleScrollState(e.currentTarget)
            props.onTurnBackfillScroll()
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
              <LoadEarlierButton
                show={props.turnStart > 0 || props.historyMore}
                loading={props.historyLoading}
                loadingLabel={language.t("session.messages.loadingEarlier")}
                loadLabel={language.t("session.messages.loadEarlier")}
                onLoadEarlier={props.onLoadEarlier}
              />
              <For each={rendered()}>
                {(messageID) => {
                  const active = createMemo(() => activeMessageID() === messageID)
                  return (
                    <TimelineMessage
                      messageID={messageID}
                      anchorID={props.anchor(messageID)}
                      centered={props.centered}
                      parts={sync.data.part[messageID]}
                      active={active()}
                      sessionID={sessionID() ?? ""}
                      sessionMessages={sessionMessages()}
                      actions={props.actions}
                      status={active() ? sessionStatus() : undefined}
                      showReasoningSummaries={settings.general.showReasoningSummaries()}
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
                    />
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
