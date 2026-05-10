import type { RendererDiagnosticInput } from "@/context/platform"

export type TimelineScrollMode = "following_latest" | "reading_history" | "targeting_message"

export type TimelineDockKind = "composer" | "question" | "permission" | "todo" | "followup" | "revert" | "prompt"

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
  | "submit_restore_latest_after_top_reset"
  | "explicit_top_navigation"
  | "explicit_bottom_navigation"
  | "follow_latest_preserved"
  | "strong_upward_navigation"
  | "strong_downward_navigation"
  | "weak_scroll_observed"
  | "scrollbar_drag_started"
  | "scrollbar_drag_preserve_reading"
  | "reading_anchor_preserved"
  | "content_resize_preserve_reading"
  | "dock_resize_preserve_anchor"
  | "window_changed_preserve_target"
  | "target_message_requested"
  | "target_load_exhausted_fallback"
  | "owner_mismatch_cancelled"
  | "owner_detached"
  | "anchor_unrecoverable_fallback"

export type TimelineRecovery =
  | { type: "none" }
  | {
      type: "restore_anchor"
      reason: TimelineScrollReason
      anchor: TimelineSafePosition
    }
  | {
      type: "restore_latest"
      reason: TimelineScrollReason
    }

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
    }
  | {
      type: "owner_detached"
      sessionOwner: string
      viewportOwner: string
    }

export type TimelineScrollControllerResult = {
  accepted: boolean
  recovery: TimelineRecovery
  reason: TimelineScrollReason
}

export type TimelineScrollControllerState = {
  mode: TimelineScrollMode
  lastSafePosition: TimelineSafePosition
  lastIntent?: TimelineScrollIntent
  pendingRecovery: TimelineRecovery
  sessionOwner: string
  viewportOwner: string
  submitOriginMode?: TimelineScrollMode
  latestProtected: boolean
}

export type TimelineScrollDiagnosticData = {
  mode_before: TimelineScrollMode
  mode_after: TimelineScrollMode
  intent_type?: string
  intent_source?: string
  observation_type?: string
  accepted: boolean
  recovery: boolean
  reason: TimelineScrollReason
  anchor_kind?: TimelineSafePosition["kind"]
  anchor_message_id?: string
  submit_origin_mode?: TimelineScrollMode
  near_top?: boolean
  near_bottom?: boolean
  near_anchor?: boolean
  session_owner: string
  viewport_owner: string
  coalesced_count?: number
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

const noRecovery: TimelineRecovery = { type: "none" }

function cloneState(state: TimelineScrollControllerState): TimelineScrollControllerState {
  return {
    ...state,
    lastSafePosition: { ...state.lastSafePosition },
    pendingRecovery:
      state.pendingRecovery.type === "restore_anchor"
        ? { ...state.pendingRecovery, anchor: { ...state.pendingRecovery.anchor } }
        : { ...state.pendingRecovery },
  }
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

function diagnosticData(input: {
  before: TimelineScrollControllerState
  after: TimelineScrollControllerState
  intent?: TimelineScrollIntent
  observation?: TimelineScrollObservation
  accepted: boolean
  recovery: TimelineRecovery
  reason: TimelineScrollReason
  coalescedCount?: number
}): TimelineScrollDiagnosticData {
  const observation = input.observation
  const metrics = observation && "metrics" in observation ? observation.metrics : undefined
  const intent = input.intent
  const intentSource = intent && "source" in intent ? intent.source : undefined
  const anchor = input.recovery.type === "restore_anchor" ? input.recovery.anchor : input.after.lastSafePosition
  return {
    mode_before: input.before.mode,
    mode_after: input.after.mode,
    intent_type: input.intent?.type,
    intent_source: intentSource,
    observation_type: input.observation?.type,
    accepted: input.accepted,
    recovery: input.recovery.type !== "none",
    reason: input.reason,
    anchor_kind: anchorKind(anchor),
    anchor_message_id: anchorMessageID(anchor),
    submit_origin_mode: input.after.submitOriginMode,
    near_top: metrics?.nearTop,
    near_bottom: metrics?.nearBottom,
    near_anchor: input.recovery.type === "restore_anchor",
    session_owner: input.after.sessionOwner,
    viewport_owner: input.after.viewportOwner,
    coalesced_count: input.coalescedCount,
  }
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

function isExplicitTopIntent(intent: TimelineScrollIntent) {
  if (intent.type === "keyboard_scroll") return intent.key === "Home" || intent.key === "PageUp"
  if (intent.type === "wheel_scroll" || intent.type === "touch_scroll") {
    return intent.direction === "up" && intent.strength === "strong" && !intent.nestedScrollable
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

function updateSafePosition(state: TimelineScrollControllerState, safePosition: TimelineSafePosition | undefined) {
  if (safePosition) state.lastSafePosition = safePosition
}

function updateObservedSafePosition(state: TimelineScrollControllerState, safePosition: TimelineSafePosition | undefined) {
  if (
    state.mode === "targeting_message" &&
    state.lastSafePosition.kind === "target_message" &&
    safePosition?.kind !== "target_message"
  ) {
    return
  }
  updateSafePosition(state, safePosition)
}

export function createSessionTimelineScrollController(
  options: SessionTimelineScrollControllerOptions,
): SessionTimelineScrollController {
  const state: TimelineScrollControllerState = {
    mode: "following_latest",
    lastSafePosition: { kind: "latest" },
    pendingRecovery: noRecovery,
    sessionOwner: options.sessionOwner,
    viewportOwner: options.viewportOwner,
    latestProtected: false,
  }

  const emit = (input: {
    before: TimelineScrollControllerState
    intent?: TimelineScrollIntent
    observation?: TimelineScrollObservation
    accepted: boolean
    recovery: TimelineRecovery
    reason: TimelineScrollReason
  }) => {
    options.emitDiagnostic?.(
      createTimelineScrollControllerDiagnostic({
        routeSessionID: options.routeSessionID,
        visibleSessionID: options.visibleSessionID,
        timelineSessionID: options.timelineSessionID,
        data: diagnosticData({ ...input, after: cloneState(state) }),
      }),
    )
  }

  const result = (input: {
    before: TimelineScrollControllerState
    intent?: TimelineScrollIntent
    observation?: TimelineScrollObservation
    accepted: boolean
    recovery: TimelineRecovery
    reason: TimelineScrollReason
  }): TimelineScrollControllerResult => {
    state.pendingRecovery = input.recovery
    emit(input)
    return {
      accepted: input.accepted,
      recovery: input.recovery,
      reason: input.reason,
    }
  }

  return {
    state: () => cloneState(state),
    intent(intent) {
      const before = cloneState(state)
      state.lastIntent = intent

      if (intent.type === "submit") {
        state.mode = "following_latest"
        state.submitOriginMode = intent.originMode
        state.latestProtected = true
        state.lastSafePosition = { kind: "latest" }
        return result({
          before,
          intent,
          accepted: true,
          recovery: { type: "restore_latest", reason: "submit_follow_latest" },
          reason: "submit_follow_latest",
        })
      }

      if (intent.type === "target_message") {
        state.mode = "targeting_message"
        state.latestProtected = false
        state.lastSafePosition = {
          kind: "target_message",
          messageID: intent.messageID,
          align: intent.align,
          loadPolicy: "load_until_visible",
        }
        return result({
          before,
          intent,
          accepted: true,
          recovery: { type: "restore_anchor", reason: "target_message_requested", anchor: state.lastSafePosition },
          reason: "target_message_requested",
        })
      }

      if (isExplicitBottomIntent(intent)) {
        state.mode = "following_latest"
        state.latestProtected = true
        state.lastSafePosition = { kind: "latest" }
        return result({
          before,
          intent,
          accepted: true,
          recovery: { type: "restore_latest", reason: "explicit_bottom_navigation" },
          reason: "explicit_bottom_navigation",
        })
      }

      if (isExplicitTopIntent(intent)) {
        state.mode = "reading_history"
        state.latestProtected = false
        const reason = intent.type === "keyboard_scroll" ? "explicit_top_navigation" : "strong_upward_navigation"
        return result({
          before,
          intent,
          accepted: true,
          recovery: noRecovery,
          reason,
        })
      }

      if (
        (intent.type === "wheel_scroll" || intent.type === "touch_scroll") &&
        intent.direction === "down" &&
        intent.strength === "strong" &&
        !intent.nestedScrollable
      ) {
        return result({
          before,
          intent,
          accepted: true,
          recovery: noRecovery,
          reason: "strong_downward_navigation",
        })
      }

      if (intent.type === "scrollbar_drag_start") {
        state.mode = "reading_history"
        state.latestProtected = false
        return result({
          before,
          intent,
          accepted: true,
          recovery: noRecovery,
          reason: "scrollbar_drag_started",
        })
      }

      return result({
        before,
        intent,
        accepted: true,
        recovery: noRecovery,
        reason: "weak_scroll_observed",
      })
    },
    observe(observation) {
      const before = cloneState(state)

      if (observation.type === "owner_detached") {
        const ownerMatches =
          observation.sessionOwner === state.sessionOwner && observation.viewportOwner === state.viewportOwner
        if (ownerMatches) {
          state.pendingRecovery = noRecovery
          state.latestProtected = false
        }
        return result({
          before,
          observation,
          accepted: ownerMatches,
          recovery: noRecovery,
          reason: ownerMatches ? "owner_detached" : "owner_mismatch_cancelled",
        })
      }

      if (observation.type === "scroll_sample") {
        if (observation.metrics.nearBottom) {
          updateObservedSafePosition(state, observation.safePosition ?? { kind: "latest" })
          if (state.lastIntent && isExplicitBottomIntent(state.lastIntent)) {
            state.mode = "following_latest"
            state.latestProtected = true
            return result({
              before,
              observation,
              accepted: true,
              recovery: noRecovery,
              reason: "explicit_bottom_navigation",
            })
          }
        }

        if (
          state.mode === "following_latest" &&
          state.latestProtected &&
          observation.metrics.nearTop &&
          !observation.metrics.nearBottom &&
          !(state.lastIntent && isExplicitTopIntent(state.lastIntent))
        ) {
          return result({
            before,
            observation,
            accepted: false,
            recovery: { type: "restore_latest", reason: "submit_restore_latest_after_top_reset" },
            reason: "submit_restore_latest_after_top_reset",
          })
        }

        updateObservedSafePosition(state, observation.safePosition)
        return result({
          before,
          observation,
          accepted: true,
          recovery: noRecovery,
          reason: state.mode === "reading_history" ? "reading_anchor_preserved" : "weak_scroll_observed",
        })
      }

      if (state.mode === "reading_history" && state.lastSafePosition.kind === "reading") {
        const reason =
          observation.type === "content_resize"
            ? "content_resize_preserve_reading"
            : observation.type === "dock_resize"
              ? "dock_resize_preserve_anchor"
              : "reading_anchor_preserved"
        return result({
          before,
          observation,
          accepted: true,
          recovery: {
            type: "restore_anchor",
            reason,
            anchor: state.lastSafePosition,
          },
          reason,
        })
      }

      if (state.mode === "targeting_message" && state.lastSafePosition.kind === "target_message") {
        return result({
          before,
          observation,
          accepted: true,
          recovery: {
            type: "restore_anchor",
            reason: "window_changed_preserve_target",
            anchor: state.lastSafePosition,
          },
          reason: "window_changed_preserve_target",
        })
      }

      if (state.mode === "following_latest") {
        return result({
          before,
          observation,
          accepted: true,
          recovery: { type: "restore_latest", reason: "follow_latest_preserved" },
          reason: "follow_latest_preserved",
        })
      }

      return result({
        before,
        observation,
        accepted: true,
        recovery: noRecovery,
        reason: "weak_scroll_observed",
      })
    },
    detach(owner) {
      const before = cloneState(state)
      const ownerMatches = owner.sessionOwner === state.sessionOwner && owner.viewportOwner === state.viewportOwner
      if (ownerMatches) {
        state.pendingRecovery = noRecovery
        state.latestProtected = false
      }
      return result({
        before,
        observation: {
          type: "owner_detached",
          sessionOwner: owner.sessionOwner,
          viewportOwner: owner.viewportOwner,
        },
        accepted: ownerMatches,
        recovery: noRecovery,
        reason: ownerMatches ? "owner_detached" : "owner_mismatch_cancelled",
      })
    },
  }
}
