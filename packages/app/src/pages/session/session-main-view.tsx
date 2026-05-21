import { Match, onCleanup, onMount, Show, Switch, type ComponentProps, type JSX } from "solid-js"
import { Tabs } from "@opencode-ai/ui/tabs"
import { NewSessionView, SessionHeader } from "@/components/session"
import type { useLanguage } from "@/context/language"
import type { createSizing } from "@/pages/session/helpers"
import { MessageTimeline } from "@/pages/session/message-timeline"
import { SessionSidePanel } from "@/pages/session/session-side-panel"
import { TerminalPanel } from "@/pages/session/terminal-panel"
import { shouldShowSessionOpeningState } from "@/pages/session/session-main-view-state"
import type { createSessionHistoryWindow } from "@/pages/session/use-session-history-window"
import type { createSessionReviewState } from "@/pages/session/use-session-review-state"
import type { createSessionScrollDock } from "@/pages/session/use-session-scroll-dock"
import { timelineDriverEnabled, timelineEvent, type TimelineDriverEvent } from "@/testing/timeline"

type TimelineProps = ComponentProps<typeof MessageTimeline>

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
  mobileChanges: boolean
  mobileFallback: JSX.Element
  actions: TimelineProps["actions"]
  scroll: ReturnType<typeof createSessionScrollDock>["scroll"]
  resumeScroll: () => void
  setScrollRef: TimelineProps["setScrollRef"]
  scheduleScrollState: TimelineProps["onScheduleScrollState"]
  autoScroll: ReturnType<typeof createSessionScrollDock>["autoScroll"]
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
  layoutTransactionActive: TimelineProps["layoutTransactionActive"]
  layoutTransactionID: TimelineProps["layoutTransactionID"]
  layoutTransactionKind: TimelineProps["layoutTransactionKind"]
  onRetryOpenSession: () => void
  onOpenNewSession: () => void
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
  onMount(() => {
    const timelineDriverTestRuntime = import.meta.env.DEV || import.meta.env.TEST
    if (!timelineDriverTestRuntime) return

    const handleTimelineDriver = (event: Event) => {
      if (!timelineDriverEnabled({ testRuntime: timelineDriverTestRuntime })) return
      const detail = (event as TimelineDriverEvent).detail
      if (detail?.sessionID && detail.sessionID !== props.timelineSessionID) return
      if (detail?.action === "reveal-cached") props.historyWindow.expandForHash(0)
    }
    window.addEventListener(timelineEvent, handleTimelineDriver)
    onCleanup(() => window.removeEventListener(timelineEvent, handleTimelineDriver))
  })

  const showSessionOpeningState = () =>
    shouldShowSessionOpeningState({
      activeSessionID: props.activeSessionID,
      routeSessionID: props.routeSessionID,
      routeReady: props.routeReady,
      timelineSessionID: props.timelineSessionID,
    })

  return (
    <div class="relative size-full overflow-hidden flex flex-col">
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
          <div class="flex-1 min-h-0 overflow-hidden">
            <Switch>
              <Match when={showSessionOpeningState()}>
                <div
                  class="size-full flex items-center justify-center px-6 text-center"
                  role="status"
                  data-component="session-opening-state"
                  data-transitioning={props.transitioning ? "true" : "false"}
                >
                  <div class="flex flex-col items-center gap-2">
                    <div class="size-8 rounded-full border border-border-weak border-t-brand-primary animate-spin" />
                    <div class="text-h3 text-fg-strong">{props.language.t("session.opening")}</div>
                    <div class="text-caption text-fg-weak">{props.language.t("session.messages.loading")}</div>
                    <div class="mt-2 flex items-center justify-center gap-2">
                      <button
                        type="button"
                        class="rounded-md border border-border-weak px-3 py-1 text-body text-fg-base transition-colors hover:bg-surface-raised focus:outline-none focus-visible:bg-surface-raised"
                        onClick={props.onRetryOpenSession}
                      >
                        {props.language.t("common.retry")}
                      </button>
                      <button
                        type="button"
                        class="rounded-md border border-border-weak px-3 py-1 text-body text-fg-base transition-colors hover:bg-surface-raised focus:outline-none focus-visible:bg-surface-raised"
                        onClick={props.onOpenNewSession}
                      >
                        {props.language.t("command.session.new")}
                      </button>
                    </div>
                  </div>
                </div>
              </Match>
              <Match when={props.activeSessionID && props.timelineSessionID ? props.timelineSessionID : undefined}>
                <MessageTimeline
                  sessionID={props.timelineSessionID ?? ""}
                  sessionKey={props.timelineSessionKey}
                  sessionMessages={props.timelineMessages}
                  mobileChanges={props.mobileChanges}
                  mobileFallback={props.mobileFallback}
                  actions={props.actions}
                  scroll={props.scroll}
                  onResumeScroll={props.resumeScroll}
                  setScrollRef={props.setScrollRef}
                  onScheduleScrollState={props.scheduleScrollState}
                  onAutoScrollHandleScroll={props.autoScroll.handleScroll}
                  onMarkScrollGesture={props.markScrollGesture}
                  hasScrollGesture={props.hasScrollGesture}
                  onUserScroll={props.markUserScroll}
                  onTimelineScrollIntent={props.onTimelineScrollIntent}
                  onTimelineScrollObservation={props.onTimelineScrollObservation}
                  onTurnBackfillScroll={props.historyWindow.onScrollerScroll}
                  onAutoScrollInteraction={props.autoScroll.handleInteraction}
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
                  layoutTransactionActive={props.layoutTransactionActive}
                  layoutTransactionID={props.layoutTransactionID}
                  layoutTransactionKind={props.layoutTransactionKind}
                />
              </Match>
              <Match when={!props.activeSessionID}>
                <NewSessionView composer={props.composerHome} />
              </Match>
              <Match when={props.activeSessionID}>
                <div class="flex-1 min-h-0" />
              </Match>
            </Switch>
          </div>
          <Show when={props.activeSessionID && !showSessionOpeningState()}>{props.composerSession}</Show>
        </div>

        <SessionSidePanel
          canReview={props.canReview}
          diffs={props.reviewDiffs}
          hasReview={props.hasReview}
          reviewCount={props.reviewCount}
          reviewPanel={props.reviewPanel}
          files={props.files}
          terminalPanel={() => <TerminalPanel embedded />}
          size={props.size}
        />
      </div>

      <Show when={!props.isDesktop}>
        <TerminalPanel />
      </Show>
    </div>
  )
}
