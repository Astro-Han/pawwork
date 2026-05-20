import type { RendererDiagnosticInput } from "@/context/platform"

export type TimelineScrollCommandType =
  | "anchor-restore"
  | "bottom-follow"
  | "content-resize-bottom-follow"
  | "dock-resize-bottom-follow"
  | "hash-target"
  | "history-prepend-preserve"
  | "target-message"

export type TimelineScrollCommandMethod = "scroll-to" | "set-scroll-top"

export type TimelineScrollCommandMetrics = {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  distanceFromBottom: number
}

export type TimelineScrollCommandContext = {
  routeSessionID?: string
  visibleSessionID?: string
  timelineSessionID?: string
}

export type TimelineScrollCommandRecord = TimelineScrollCommandContext & {
  monotonicMs: number
  type: TimelineScrollCommandType
  source: string
  method: TimelineScrollCommandMethod
  top: number
  behavior?: ScrollBehavior
  reason?: string
  before?: TimelineScrollCommandMetrics
  after?: TimelineScrollCommandMetrics
}

type TimelineScrollCommandBase = {
  element: HTMLElement
  top: number
  type: TimelineScrollCommandType
  source: string
  reason?: string
}

export type TimelineSetScrollTopCommand = TimelineScrollCommandBase
export type TimelineScrollToCommand = TimelineScrollCommandBase & { behavior?: ScrollBehavior }

export type TimelineScrollCommandSink = {
  setScrollTop: (command: TimelineSetScrollTopCommand) => TimelineScrollCommandRecord
  scrollTo: (command: TimelineScrollToCommand) => TimelineScrollCommandRecord
  records: () => TimelineScrollCommandRecord[]
}

export function collectTimelineScrollCommandMetrics(element: HTMLElement): TimelineScrollCommandMetrics {
  const distanceFromBottom = Math.max(0, element.scrollHeight - element.clientHeight - element.scrollTop)
  return {
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    distanceFromBottom,
  }
}

export function createTimelineScrollCommandSink(input?: {
  emitDiagnostic?: (event: RendererDiagnosticInput) => Promise<void> | void
  fullMetricsEnabled?: () => boolean
  getContext?: () => TimelineScrollCommandContext
  maxRecords?: number
  now?: () => number
}): TimelineScrollCommandSink {
  const maxRecords = Math.max(1, input?.maxRecords ?? 100)
  const records: TimelineScrollCommandRecord[] = []
  const now = input?.now ?? (() => performance.now())

  const remember = (record: TimelineScrollCommandRecord) => {
    records.push(record)
    while (records.length > maxRecords) records.shift()
    input?.emitDiagnostic?.({
      name: "session.timeline.scroll_command",
      route_session_id: record.routeSessionID,
      visible_session_id: record.visibleSessionID,
      timeline_session_id: record.timelineSessionID,
      monotonic_ms: record.monotonicMs,
      data: {
        command_type: record.type,
        command_method: record.method,
        command_source: record.source,
        command_reason: record.reason,
        command_top: record.top,
        command_behavior: record.behavior,
        before_scroll_top: record.before?.scrollTop,
        before_distance_from_bottom: record.before?.distanceFromBottom,
        after_scroll_top: record.after?.scrollTop,
        after_distance_from_bottom: record.after?.distanceFromBottom,
      },
    })
    return record
  }

  const execute = (
    command: TimelineSetScrollTopCommand | TimelineScrollToCommand,
    method: TimelineScrollCommandMethod,
    apply: () => void,
  ) => {
    const fullMetrics = input?.fullMetricsEnabled?.() ?? false
    const before = fullMetrics ? collectTimelineScrollCommandMetrics(command.element) : undefined
    apply()
    const after = fullMetrics ? collectTimelineScrollCommandMetrics(command.element) : undefined
    return remember({
      ...(input?.getContext?.() ?? {}),
      monotonicMs: now(),
      type: command.type,
      source: command.source,
      method,
      top: command.top,
      behavior: "behavior" in command ? command.behavior : undefined,
      reason: command.reason,
      before,
      after,
    })
  }

  return {
    setScrollTop: (command) =>
      execute(command, "set-scroll-top", () => {
        command.element.scrollTop = command.top
      }),
    scrollTo: (command) =>
      execute(command, "scroll-to", () => {
        command.element.scrollTo({ top: command.top, behavior: command.behavior })
      }),
    records: () => [...records],
  }
}
