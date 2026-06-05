import type { RendererDiagnosticInput } from "@/context/platform"

export type TimelineScrollMode = "following_latest" | "reading_history" | "targeting_message"

export type TimelineDockKind = "composer" | "question" | "permission" | "followup" | "revert" | "prompt"

export type TimelineScrollMetrics = {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  distanceFromTop: number
  distanceFromBottom: number
  nearTop: boolean
  nearBottom: boolean
}

export type TimelineSafePosition =
  | { kind: "latest"; messageID?: string }
  | {
      kind: "reading"
      anchorMessageID: string
      offsetFromViewportTop: number
      renderedStart: number
      renderedCount: number
    }
  | {
      kind: "target_message"
      messageID: string
      align: "nearest" | "top" | "center"
      offsetFromViewportTop?: number
      loadPolicy: "load_until_visible" | "visible_only"
    }

export type TimelineScrollReason =
  | "submit_follow_latest"
  | "explicit_top_navigation"
  | "explicit_bottom_navigation"
  | "user_upward_navigation"
  | "strong_downward_navigation"
  | "reached_bottom_follow_latest"
  | "reading_anchor_sampled"
  | "weak_scroll_observed"
  | "scrollbar_drag_started"
  | "target_message_requested"
  | "owner_detached"
  | "owner_mismatch_cancelled"

export type TimelineScrollIntent =
  | {
      type: "keyboard_scroll"
      key: "ArrowUp" | "ArrowDown" | "PageUp" | "PageDown" | "Home" | "End"
      source: "scroll_view"
    }
  | {
      type: "scrollbar_drag_start" | "scrollbar_drag_end"
      source: "scroll_view"
      metrics: TimelineScrollMetrics
    }
  | {
      type: "wheel_scroll" | "touch_scroll"
      source: "timeline"
      direction: "up" | "down"
      strength: "weak" | "strong"
      nestedScrollable: boolean
    }
  | {
      type: "jump_latest"
      source: "button" | "keyboard" | "submit"
    }
  | {
      type: "submit"
      originMode: TimelineScrollMode
    }
  | {
      type: "target_message"
      messageID: string
      align: "nearest" | "top" | "center"
    }

export type TimelineScrollObservation =
  | {
      type: "scroll_sample"
      metrics: TimelineScrollMetrics
      safePosition?: TimelineSafePosition
    }
  | {
      type: "window_changed"
      renderedStart: number
      renderedCount: number
      metrics: TimelineScrollMetrics
    }
  | {
      type: "content_resize"
      metrics: TimelineScrollMetrics
    }
  | {
      type: "dock_resize"
      dockKind: TimelineDockKind
      previousDockHeight: number
      nextDockHeight: number
      metrics: TimelineScrollMetrics
      layoutTransactionHandled?: boolean
    }
  | {
      type: "owner_detached"
      sessionOwner: string
      viewportOwner: string
    }

/**
 * The controller is a pure anchor-intent reducer. It decides *which anchor* the
 * timeline should be pinned to (the mode + `lastSafePosition`); the reconciler
 * is the single authoritative writer that makes the viewport match it. The
 * reducer never writes `scrollTop` and never emits a recovery command.
 */
export type TimelineScrollControllerResult = {
  accepted: boolean
  mode: TimelineScrollMode
  anchorChanged: boolean
  reason: TimelineScrollReason
}

export type TimelineScrollControllerState = {
  mode: TimelineScrollMode
  lastSafePosition: TimelineSafePosition
  sessionOwner: string
  viewportOwner: string
}

export type TimelineScrollDiagnosticData = {
  mode_before: TimelineScrollMode
  mode_after: TimelineScrollMode
  intent_type?: string
  intent_source?: string
  observation_type?: string
  accepted: boolean
  anchor_changed: boolean
  reason: TimelineScrollReason
  anchor_kind?: TimelineSafePosition["kind"]
  anchor_message_id?: string
  near_top?: boolean
  near_bottom?: boolean
  session_owner: string
  viewport_owner: string
}

export type TimelineScrollDiagnosticEvent = RendererDiagnosticInput & {
  name: "session.timeline.scroll_controller"
  data: TimelineScrollDiagnosticData
}

export type SessionTimelineScrollControllerOptions = {
  sessionOwner: string
  viewportOwner: string
  routeSessionID?: string
  visibleSessionID?: string
  timelineSessionID?: string
  emitDiagnostic?: (event: TimelineScrollDiagnosticEvent) => void
}

export type SessionTimelineScrollController = {
  state: () => TimelineScrollControllerState
  intent: (intent: TimelineScrollIntent) => TimelineScrollControllerResult
  observe: (observation: TimelineScrollObservation) => TimelineScrollControllerResult
  detach: (owner: { sessionOwner: string; viewportOwner: string }) => TimelineScrollControllerResult
}

export type TimelineGestureClassification = {
  direction: "up" | "down"
  strength: "weak" | "strong"
  nestedScrollable: boolean
}

const STRONG_GESTURE_MIN_PX = 160
const STRONG_GESTURE_VIEWPORT_RATIO = 0.25

export function classifyTimelineScrollGesture(input: {
  deltaY: number
  viewportHeight: number
  nestedScrollable: boolean
  atNestedBoundary: boolean
}): TimelineGestureClassification {
  const threshold = Math.max(STRONG_GESTURE_MIN_PX, input.viewportHeight * STRONG_GESTURE_VIEWPORT_RATIO)
  const nestedScrollable = input.nestedScrollable && !input.atNestedBoundary
  return {
    direction: input.deltaY < 0 ? "up" : "down",
    strength: Math.abs(input.deltaY) >= threshold ? "strong" : "weak",
    nestedScrollable,
  }
}

function cloneState(state: TimelineScrollControllerState): TimelineScrollControllerState {
  return { ...state, lastSafePosition: { ...state.lastSafePosition } }
}

function anchorKind(position: TimelineSafePosition | undefined) {
  return position?.kind
}

function anchorMessageID(position: TimelineSafePosition | undefined) {
  if (!position) return undefined
  if (position.kind === "latest") return position.messageID
  if (position.kind === "reading") return position.anchorMessageID
  return position.messageID
}

function isExplicitTopIntent(intent: TimelineScrollIntent) {
  if (intent.type === "keyboard_scroll")
    return intent.key === "ArrowUp" || intent.key === "Home" || intent.key === "PageUp"
  if (intent.type === "wheel_scroll" || intent.type === "touch_scroll") {
    return intent.direction === "up" && !intent.nestedScrollable
  }
  if (intent.type === "scrollbar_drag_end") return !intent.metrics.nearBottom
  return false
}

function isExplicitBottomIntent(intent: TimelineScrollIntent) {
  if (intent.type === "keyboard_scroll") return intent.key === "End"
  if (intent.type === "jump_latest" || intent.type === "submit") return true
  if (intent.type === "scrollbar_drag_end") return intent.metrics.nearBottom
  return false
}

export function createTimelineScrollControllerDiagnostic(input: {
  routeSessionID?: string
  visibleSessionID?: string
  timelineSessionID?: string
  data: TimelineScrollDiagnosticData
}): TimelineScrollDiagnosticEvent {
  return {
    name: "session.timeline.scroll_controller",
    route_session_id: input.routeSessionID,
    visible_session_id: input.visibleSessionID,
    timeline_session_id: input.timelineSessionID,
    data: input.data,
  }
}

export function createSessionTimelineScrollController(
  options: SessionTimelineScrollControllerOptions,
): SessionTimelineScrollController {
  const state: TimelineScrollControllerState = {
    mode: "following_latest",
    lastSafePosition: { kind: "latest" },
    sessionOwner: options.sessionOwner,
    viewportOwner: options.viewportOwner,
  }

  const emit = (input: {
    before: TimelineScrollControllerState
    intent?: TimelineScrollIntent
    observation?: TimelineScrollObservation
    accepted: boolean
    anchorChanged: boolean
    reason: TimelineScrollReason
  }) => {
    const observation = input.observation
    const metrics = observation && "metrics" in observation ? observation.metrics : undefined
    const intentSource = input.intent && "source" in input.intent ? input.intent.source : undefined
    options.emitDiagnostic?.(
      createTimelineScrollControllerDiagnostic({
        routeSessionID: options.routeSessionID,
        visibleSessionID: options.visibleSessionID,
        timelineSessionID: options.timelineSessionID,
        data: {
          mode_before: input.before.mode,
          mode_after: state.mode,
          intent_type: input.intent?.type,
          intent_source: intentSource,
          observation_type: input.observation?.type,
          accepted: input.accepted,
          anchor_changed: input.anchorChanged,
          reason: input.reason,
          anchor_kind: anchorKind(state.lastSafePosition),
          anchor_message_id: anchorMessageID(state.lastSafePosition),
          near_top: metrics?.nearTop,
          near_bottom: metrics?.nearBottom,
          session_owner: state.sessionOwner,
          viewport_owner: state.viewportOwner,
        },
      }),
    )
  }

  const result = (input: {
    before: TimelineScrollControllerState
    intent?: TimelineScrollIntent
    observation?: TimelineScrollObservation
    accepted: boolean
    anchorChanged: boolean
    reason: TimelineScrollReason
  }): TimelineScrollControllerResult => {
    emit(input)
    return { accepted: input.accepted, mode: state.mode, anchorChanged: input.anchorChanged, reason: input.reason }
  }

  const followLatest = (
    before: TimelineScrollControllerState,
    intent: TimelineScrollIntent | undefined,
    observation: TimelineScrollObservation | undefined,
    reason: TimelineScrollReason,
  ) => {
    state.mode = "following_latest"
    state.lastSafePosition = { kind: "latest" }
    return result({ before, intent, observation, accepted: true, anchorChanged: true, reason })
  }

  return {
    state: () => cloneState(state),
    intent(intent) {
      const before = cloneState(state)

      if (intent.type === "submit") {
        return followLatest(before, intent, undefined, "submit_follow_latest")
      }

      if (intent.type === "target_message") {
        state.mode = "targeting_message"
        state.lastSafePosition = {
          kind: "target_message",
          messageID: intent.messageID,
          align: intent.align,
          loadPolicy: "load_until_visible",
        }
        return result({ before, intent, accepted: true, anchorChanged: true, reason: "target_message_requested" })
      }

      if (isExplicitBottomIntent(intent)) {
        return followLatest(before, intent, undefined, "explicit_bottom_navigation")
      }

      if (isExplicitTopIntent(intent)) {
        // Any upward navigation leaves follow mode immediately, regardless of
        // gesture strength. The reading anchor is sampled by the host on the
        // scroll event that accompanies this gesture.
        const wasReading = state.mode === "reading_history"
        state.mode = "reading_history"
        const reason = intent.type === "keyboard_scroll" ? "explicit_top_navigation" : "user_upward_navigation"
        return result({ before, intent, accepted: true, anchorChanged: !wasReading, reason })
      }

      if (
        (intent.type === "wheel_scroll" || intent.type === "touch_scroll") &&
        intent.direction === "down" &&
        intent.strength === "strong" &&
        !intent.nestedScrollable
      ) {
        return result({ before, intent, accepted: true, anchorChanged: false, reason: "strong_downward_navigation" })
      }

      if (intent.type === "scrollbar_drag_start") {
        const wasReading = state.mode === "reading_history"
        state.mode = "reading_history"
        return result({ before, intent, accepted: true, anchorChanged: !wasReading, reason: "scrollbar_drag_started" })
      }

      return result({ before, intent, accepted: true, anchorChanged: false, reason: "weak_scroll_observed" })
    },
    observe(observation) {
      const before = cloneState(state)

      if (observation.type === "owner_detached") {
        const ownerMatches =
          observation.sessionOwner === state.sessionOwner && observation.viewportOwner === state.viewportOwner
        return result({
          before,
          observation,
          accepted: ownerMatches,
          anchorChanged: false,
          reason: ownerMatches ? "owner_detached" : "owner_mismatch_cancelled",
        })
      }

      if (observation.type === "scroll_sample") {
        // Reaching the bottom is the signal to resume following the latest output,
        // mirroring the old auto-scroll "distance < threshold" behavior.
        if (observation.metrics.nearBottom) {
          return followLatest(before, undefined, observation, "reached_bottom_follow_latest")
        }

        if (state.mode === "reading_history" && observation.safePosition?.kind === "reading") {
          state.lastSafePosition = observation.safePosition
          return result({
            before,
            observation,
            accepted: true,
            anchorChanged: true,
            reason: "reading_anchor_sampled",
          })
        }

        return result({ before, observation, accepted: true, anchorChanged: false, reason: "weak_scroll_observed" })
      }

      // content_resize / dock_resize / window_changed do not change intent.
      // The host marks the reconciler dirty so the current anchor is re-pinned.
      return result({ before, observation, accepted: true, anchorChanged: false, reason: "weak_scroll_observed" })
    },
    detach(owner) {
      const before = cloneState(state)
      const ownerMatches = owner.sessionOwner === state.sessionOwner && owner.viewportOwner === state.viewportOwner
      return result({
        before,
        observation: { type: "owner_detached", sessionOwner: owner.sessionOwner, viewportOwner: owner.viewportOwner },
        accepted: ownerMatches,
        anchorChanged: false,
        reason: ownerMatches ? "owner_detached" : "owner_mismatch_cancelled",
      })
    },
  }
}
