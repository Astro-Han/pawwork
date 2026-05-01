import { Match, Show, Switch, type ComponentProps, type JSX } from "solid-js"
import { Tabs } from "@opencode-ai/ui/tabs"
import { NewSessionView, SessionHeader } from "@/components/session"
import type { PawworkSkillName } from "@/components/session/pawwork-skill-meta"
import type { useLanguage } from "@/context/language"
import type { createSizing } from "@/pages/session/helpers"
import { MessageTimeline } from "@/pages/session/message-timeline"
import { SessionSidePanel } from "@/pages/session/session-side-panel"
import { TerminalPanel } from "@/pages/session/terminal-panel"
import type { createSessionHistoryWindow } from "@/pages/session/use-session-history-window"
import type { createSessionReviewState } from "@/pages/session/use-session-review-state"
import type { createSessionScrollDock } from "@/pages/session/use-session-scroll-dock"

type TimelineProps = ComponentProps<typeof MessageTimeline>

export function SessionMainView(props: {
  activeSessionID?: string
  isDesktop: boolean
  mobileTab: "session" | "changes"
  setMobileTab: (tab: "session" | "changes") => void
  language: ReturnType<typeof useLanguage>
  timelineSessionID?: string
  timelineSessionKey: string
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
  historyWindow: ReturnType<typeof createSessionHistoryWindow>
  centered: boolean
  setContentRef: TimelineProps["setContentRef"]
  historyMore: boolean
  historyLoading: boolean
  anchor: TimelineProps["anchor"]
  composerSession: JSX.Element
  composerHome: (ctx: {
    onModeChange: (mode: "normal" | "shell") => void
    selectedSkill: () => PawworkSkillName | undefined
  }) => JSX.Element
  canReview: () => boolean
  reviewDiffs: ReturnType<typeof createSessionReviewState>["reviewDiffs"]
  hasReview: ReturnType<typeof createSessionReviewState>["hasReview"]
  reviewCount: ReturnType<typeof createSessionReviewState>["reviewCount"]
  reviewPanel: () => JSX.Element
  files: ReturnType<typeof createSessionReviewState>["artifactFiles"]
  size: ReturnType<typeof createSizing>
}) {
  return (
    <div class="relative bg-background-base size-full overflow-hidden flex flex-col">
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

        <div class="@container relative min-w-[24rem] flex flex-col min-h-0 h-full bg-background-stronger flex-1">
          <div class="flex-1 min-h-0 overflow-hidden">
            <Switch>
              <Match when={props.activeSessionID && props.timelineSessionID}>
                {(sessionID) => (
                  <MessageTimeline
                    sessionID={sessionID()}
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
                  />
                )}
              </Match>
              <Match when={!props.activeSessionID}>
                <NewSessionView composer={props.composerHome} />
              </Match>
              <Match when={props.activeSessionID}>
                <div class="flex-1 min-h-0" />
              </Match>
            </Switch>
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
