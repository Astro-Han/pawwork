import { createEffect, createSignal, Match, onCleanup, Show, Switch, type ComponentProps, type JSX } from "solid-js"
import { Tabs } from "@opencode-ai/ui/tabs"
import { NewSessionView, SessionHeader } from "@/components/session"
import type { useLanguage } from "@/context/language"
import type { createSizing } from "@/pages/session/helpers"
import { MessageTimeline } from "@/pages/session/message-timeline"
import { SessionOpeningSkeleton } from "@/pages/session/session-opening-skeleton"
import { SessionSidePanel } from "@/pages/session/session-side-panel"
import { shouldShowSessionOpeningState } from "@/pages/session/session-main-view-state"
import type { createSessionHistoryWindow } from "@/pages/session/use-session-history-window"
import type { createSessionReviewState } from "@/pages/session/use-session-review-state"
import type { createSessionScrollDock } from "@/pages/session/use-session-scroll-dock"
import type { createSessionTurnChanges } from "@/pages/session/session-turn-changes"
import { TimelineE2EDriverBoundary } from "@/testing/timeline"

type TimelineProps = ComponentProps<typeof MessageTimeline>
const OPENING_SKELETON_DELAY_MS = 100
const OPENING_CROSSFADE_MS = 120

export function SessionMainView(props: {
  activeSessionID?: string
  isDesktop: boolean
  mobileTab: "session" | "changes"
  setMobileTab: (tab: "session" | "changes") => void
  language: ReturnType<typeof useLanguage>
  routeSessionID?: string
  routeReady: boolean
  transitioning: boolean
  timelineSessionID?: string
  timelineSessionKey: string
  timelineMessagesReady: boolean
  timelineMessages: TimelineProps["sessionMessages"]
  turnChangeController: ReturnType<typeof createSessionTurnChanges>
  mobileChanges: boolean
  mobileFallback: JSX.Element
  actions: TimelineProps["actions"]
  scroll: ReturnType<typeof createSessionScrollDock>["scroll"]
  resumeScroll: () => void
  setScrollRef: TimelineProps["setScrollRef"]
  scheduleScrollState: TimelineProps["onScheduleScrollState"]
  onTimelineInteraction: TimelineProps["onTimelineInteraction"]
  markScrollGesture: TimelineProps["onMarkScrollGesture"]
  hasScrollGesture: TimelineProps["hasScrollGesture"]
  markUserScroll: TimelineProps["onUserScroll"]
  onTimelineScrollIntent: TimelineProps["onTimelineScrollIntent"]
  onTimelineScrollObservation: TimelineProps["onTimelineScrollObservation"]
  historyWindow: ReturnType<typeof createSessionHistoryWindow>
  centered: boolean
  setContentRef: TimelineProps["setContentRef"]
  historyMore: boolean
  historyLoading: boolean
  anchor: TimelineProps["anchor"]
  virtualizerBridge: TimelineProps["virtualizerBridge"]
  reconcilerActive: TimelineProps["reconcilerActive"]
  composerSession: JSX.Element
  composerHome: (ctx: { onModeChange: (mode: "normal" | "shell") => void }) => JSX.Element
  canReview: () => boolean
  reviewDiffs: ReturnType<typeof createSessionReviewState>["reviewDiffs"]
  hasReview: ReturnType<typeof createSessionReviewState>["hasReview"]
  reviewCount: ReturnType<typeof createSessionReviewState>["reviewCount"]
  reviewPanel: () => JSX.Element
  files: ReturnType<typeof createSessionReviewState>["artifactFiles"]
  size: ReturnType<typeof createSizing>
}) {
  const showSessionOpeningState = () =>
    shouldShowSessionOpeningState({
      activeSessionID: props.activeSessionID,
      routeSessionID: props.routeSessionID,
      routeReady: props.routeReady,
      timelineSessionID: props.timelineSessionID,
    })
  const [openingSkeletonMounted, setOpeningSkeletonMounted] = createSignal(showSessionOpeningState())
  const [openingSkeletonVisible, setOpeningSkeletonVisible] = createSignal(false)
  let openingShowTimer: ReturnType<typeof setTimeout> | undefined
  let openingHideTimer: ReturnType<typeof setTimeout> | undefined

  createEffect(() => {
    const opening = showSessionOpeningState()
    if (openingShowTimer) clearTimeout(openingShowTimer)
    if (openingHideTimer) clearTimeout(openingHideTimer)

    if (opening) {
      setOpeningSkeletonMounted(true)
      setOpeningSkeletonVisible(false)
      openingShowTimer = setTimeout(() => {
        setOpeningSkeletonVisible(true)
        openingShowTimer = undefined
      }, OPENING_SKELETON_DELAY_MS)
      return
    }

    setOpeningSkeletonVisible(false)
    openingHideTimer = setTimeout(() => {
      setOpeningSkeletonMounted(false)
      openingHideTimer = undefined
    }, OPENING_CROSSFADE_MS)
  })

  onCleanup(() => {
    if (openingShowTimer) clearTimeout(openingShowTimer)
    if (openingHideTimer) clearTimeout(openingHideTimer)
  })

  return (
    <div class="relative size-full overflow-hidden flex flex-col">
      <TimelineE2EDriverBoundary
        timelineSessionID={() => props.timelineSessionID}
        revealCached={() => props.historyWindow.expandForHash(0)}
      />
      <SessionHeader />
      <div class="flex-1 min-h-0 flex flex-col md:flex-row">
        <Show when={!props.isDesktop && !!props.activeSessionID}>
          <Tabs value={props.mobileTab} class="h-auto">
            <Tabs.List>
              <Tabs.Trigger
                value="session"
                class="!w-1/2 !max-w-none"
                classes={{ button: "w-full" }}
                onClick={() => props.setMobileTab("session")}
              >
                {props.language.t("session.tab.session")}
              </Tabs.Trigger>
              <Tabs.Trigger
                value="changes"
                class="!w-1/2 !max-w-none !border-r-0"
                classes={{ button: "w-full" }}
                onClick={() => props.setMobileTab("changes")}
              >
                {props.hasReview()
                  ? props.language.t("session.review.filesChanged", { count: props.reviewCount() })
                  : props.language.t("session.review.change.other")}
              </Tabs.Trigger>
            </Tabs.List>
          </Tabs>
        </Show>

        <div class="@container relative min-w-[24rem] flex flex-col min-h-0 h-full flex-1">
          <div class="relative flex-1 min-h-0 overflow-hidden">
            <Switch>
              <Match when={showSessionOpeningState()}>
                <div class="flex-1 min-h-0" />
              </Match>
              <Match when={props.activeSessionID && props.timelineSessionID ? props.timelineSessionID : undefined}>
                <MessageTimeline
                  sessionID={props.timelineSessionID ?? ""}
                  sessionKey={props.timelineSessionKey}
                  sessionMessages={props.timelineMessages}
                  turnChangeController={props.turnChangeController}
                  mobileChanges={props.mobileChanges}
                  mobileFallback={props.mobileFallback}
                  actions={props.actions}
                  scroll={props.scroll}
                  onResumeScroll={props.resumeScroll}
                  setScrollRef={props.setScrollRef}
                  onScheduleScrollState={props.scheduleScrollState}
                  onMarkScrollGesture={props.markScrollGesture}
                  hasScrollGesture={props.hasScrollGesture}
                  onUserScroll={props.markUserScroll}
                  onTimelineScrollIntent={props.onTimelineScrollIntent}
                  onTimelineScrollObservation={props.onTimelineScrollObservation}
                  onTurnBackfillScroll={props.historyWindow.onScrollerScroll}
                  onTimelineInteraction={props.onTimelineInteraction}
                  centered={props.centered}
                  setContentRef={props.setContentRef}
                  turnStart={props.historyWindow.turnStart()}
                  historyMore={props.historyMore}
                  historyLoading={props.historyLoading}
                  onLoadEarlier={() => {
                    void props.historyWindow.loadAndReveal()
                  }}
                  renderedUserMessages={props.historyWindow.renderedUserMessages()}
                  anchor={props.anchor}
                  virtualizerBridge={props.virtualizerBridge}
                  reconcilerActive={props.reconcilerActive}
                />
              </Match>
              <Match when={!props.activeSessionID}>
                <NewSessionView composer={props.composerHome} />
              </Match>
              <Match when={props.activeSessionID}>
                <div class="flex-1 min-h-0" />
              </Match>
            </Switch>
            <Show when={openingSkeletonMounted()}>
              <SessionOpeningSkeleton
                visible={openingSkeletonVisible()}
                transitioning={props.transitioning}
                openingLabel={props.language.t("session.opening")}
                messages={props.timelineMessages}
                overlay
              />
            </Show>
          </div>
          <Show when={props.activeSessionID}>{props.composerSession}</Show>
        </div>

        <SessionSidePanel
          canReview={props.canReview}
          diffs={props.reviewDiffs}
          hasReview={props.hasReview}
          reviewCount={props.reviewCount}
          reviewPanel={props.reviewPanel}
          files={props.files}
          size={props.size}
        />
      </div>
    </div>
  )
}
