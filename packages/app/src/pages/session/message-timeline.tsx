import { For, createEffect, createMemo, on, onCleanup, onMount, Show, type JSX } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { SessionTurn } from "@opencode-ai/ui/session-turn"
import { isWorkInFlightStatus } from "@opencode-ai/ui/util/session-status"
import { RateLimitCardWiring } from "@/components/rate-limit-card-wiring"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import type { AssistantMessage, Message as MessageType, Part, UserMessage } from "@opencode-ai/sdk/v2"
import { showToast } from "@opencode-ai/ui/toast"
import { Binary } from "@opencode-ai/util/binary"
import { collectTimelineScrollMetrics } from "@/pages/session/session-timeline-scroll-anchors"
import {
  type TimelineScrollControllerResult,
  type TimelineScrollIntent,
  type TimelineScrollObservation,
} from "@/pages/session/session-timeline-scroll-controller"
import {
  createTouchTimelineScrollIntent,
  createWheelTimelineScrollIntent,
  scrollViewIntentToTimelineIntent,
  shouldMarkLegacyScrollIntent,
  shouldMarkTimelineBoundaryGesture,
} from "@/pages/session/session-timeline-scroll-intents"
import { createTimelineStaging } from "@/pages/session/session-timeline-staging"
import {
  areMessageCommentsEqual,
  extractMessageComments,
  SessionMessageComments,
} from "@/pages/session/session-message-comments"
import { buildTurnMessagesByUserID, emptyAssistantMessages } from "@/pages/session/session-messages"
import { createSessionTurnChanges } from "@/pages/session/session-turn-changes"
import { createSessionRunning } from "@/pages/session/session-running-state"
import { useLanguage } from "@/context/language"
import { useSessionRouteKey } from "@/pages/session/session-layout"
import { usePlatform } from "@/context/platform"
import { emitRendererDiagnostic } from "@/context/renderer-diagnostics"
import { useSettings } from "@/context/settings"
import { useShellSurface } from "@/context/shell-surface"
import { useSync } from "@/context/sync"
import { webSearchRecoveryToast } from "./websearch-toasts"

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

export { taskDescription } from "@/pages/session/task-description"

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
  const language = useLanguage()
  const shellSurface = useShellSurface()
  const { params } = useSessionRouteKey()
  const platform = usePlatform()
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
  const turnMessagesByUserID = createMemo(() => buildTurnMessagesByUserID(sessionMessages()))
  const turnChangeController = createSessionTurnChanges({ sessionID, sessionMessages })
  const webSearchToastSurfaced = new Set<string>()
  const webSearchPartCursor = new Map<string, number>()
  const webSearchPendingParts = new Map<string, Set<string>>()

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

  const activeMessageID = createMemo(() => {
    const parentID = working() ? pending()?.parentID : undefined
    if (parentID) {
      const messages = sessionMessages()
      const result = Binary.search(messages, parentID, (message) => message.id)
      const message = result.found ? messages[result.index] : messages.find((item) => item.id === parentID)
      if (message && message.role === "user") return message.id
    }

    const status = sessionStatus() ?? idle
    if (isWorkInFlightStatus(status)) {
      const messages = sessionMessages()
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") return messages[i].id
      }
    }

    return undefined
  })
  // Match the initial window cap so session switches do not reveal the window in partial batches.
  const stageCfg = { init: 10, batch: 3 }
  const staging = createTimelineStaging({
    sessionKey: () => props.sessionKey,
    turnStart: () => props.turnStart,
    messages: () => props.renderedUserMessages,
    config: stageCfg,
  })

  return (
    <Show
      when={!props.mobileChanges}
      fallback={<div class="relative h-full overflow-hidden">{props.mobileFallback}</div>}
    >
      <div class="relative w-full h-full min-w-0">
        <div
          class="absolute left-1/2 -translate-x-1/2 bottom-[calc(var(--composer-dock-height,0px)+2.5rem)] z-[60] pointer-events-none transition-opacity duration-200 ease-out"
          classList={{
            "opacity-100": props.scroll.overflow && props.scroll.jump && !staging.isStaging(),
            "opacity-0 pointer-events-none":
              !props.scroll.overflow || !props.scroll.jump || staging.isStaging(),
          }}
        >
          {/* 偏离: W1 preview L267 锁 cursor:pointer，用户 2026-05-15 决定改回默认。preview/DESIGN 同步留 follow-up。 */}
          <button
            type="button"
            class="pointer-events-auto w-[30px] h-[30px] rounded-full border border-border-weaker bg-surface-raised flex items-center justify-center p-0 transition-[background-image] hover:[background-image:linear-gradient(var(--row-hover-overlay),var(--row-hover-overlay))]"
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
            const result = createWheelTimelineScrollIntent({
              root: e.currentTarget,
              target: e.target,
              deltaY: e.deltaY,
              deltaMode: e.deltaMode,
            })
            if (!result) return
            props.onTimelineScrollIntent(result.intent)
            if (shouldMarkTimelineBoundaryGesture(result.boundary)) props.onMarkScrollGesture(e.currentTarget)
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

            const result = createTouchTimelineScrollIntent({
              root: e.currentTarget,
              target: e.target,
              delta,
            })
            if (!result) return
            props.onTimelineScrollIntent(result.intent)
            if (shouldMarkTimelineBoundaryGesture(result.boundary)) props.onMarkScrollGesture(e.currentTarget)
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
                    class="text-h3 opacity-50"
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
                  const comments = createMemo(() => extractMessageComments(sync.data.part[messageID] ?? []), [], {
                    equals: areMessageCommentsEqual,
                  })
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
                      <SessionMessageComments comments={comments()} />
                      <SessionTurn
                        sessionID={sessionID() ?? ""}
                        messageID={messageID}
                        message={userMessage()}
                        assistantMessages={turnMessagesByUserID().get(messageID) ?? emptyAssistantMessages}
                        messages={sessionMessages()}
                        actions={props.actions}
                        active={active()}
                        status={active() ? sessionStatus() : undefined}
                        rateLimitCardSlot={(classification) => <RateLimitCardWiring classification={classification} />}
                        showReasoningSummaries={settings.general.showReasoningSummaries()}
                        shellToolDefaultOpen={settings.general.shellToolPartsExpanded()}
                        editToolDefaultOpen={settings.general.editToolPartsExpanded()}
                        turnChanges={turnChangeController.turnChanges}
                        turnChangeActions={{
                          ...turnChangeController.actions,
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
