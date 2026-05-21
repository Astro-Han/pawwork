import type { RendererDiagnosticInput } from "@/context/platform"
import type { TimelineLayoutTransactionKind } from "./timeline-layout-transaction"

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

export type TimelineScrollCommandTransaction = {
  transactionID: string
  transactionKind: TimelineLayoutTransactionKind
}

type TimelineScrollCommandTransactionPartial = Partial<TimelineScrollCommandTransaction>

export type TimelineScrollCommandRecord = TimelineScrollCommandContext &
  TimelineScrollCommandTransactionPartial & {
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
  transaction?: TimelineScrollCommandTransaction
}

export type TimelineSetScrollTopCommand = TimelineScrollCommandBase
export type TimelineScrollToCommand = TimelineScrollCommandBase & { behavior?: ScrollBehavior }

export type TimelineScrollCommandSink = {
  setScrollTop: (command: TimelineSetScrollTopCommand) => TimelineScrollCommandRecord
  scrollTo: (command: TimelineScrollToCommand) => TimelineScrollCommandRecord
  records: () => TimelineScrollCommandRecord[]
  withTransaction: (transaction: TimelineScrollCommandTransaction) => TimelineScrollCommandSink
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
  activeTransaction?: () => TimelineScrollCommandTransaction | undefined
  emitDiagnostic?: (event: RendererDiagnosticInput) => Promise<void> | void
  fullMetricsEnabled?: () => boolean
  getContext?: () => TimelineScrollCommandContext
  maxRecords?: number
  now?: () => number
  transaction?: TimelineScrollCommandTransaction
}): TimelineScrollCommandSink {
  const maxRecords = Math.max(1, input?.maxRecords ?? 100)
  const records: TimelineScrollCommandRecord[] = []
  const now = input?.now ?? (() => performance.now())

  const emitDiagnostic = (event: RendererDiagnosticInput) => {
    try {
      const maybePromise = input?.emitDiagnostic?.(event)
      void maybePromise?.catch?.(() => {})
    } catch {
      // Diagnostics should never affect timeline scroll command execution.
    }
  }

  const maybeEmitTransactionViolation = (record: TimelineScrollCommandRecord) => {
    const activeTransaction = input?.activeTransaction?.()
    if (!activeTransaction) return
    if (record.transactionID === activeTransaction.transactionID) return
    emitDiagnostic({
      name: "session.timeline.layout_transaction_violation",
      route_session_id: record.routeSessionID,
      visible_session_id: record.visibleSessionID,
      timeline_session_id: record.timelineSessionID,
      monotonic_ms: record.monotonicMs,
      data: {
        transaction_id: activeTransaction.transactionID,
        transaction_kind: activeTransaction.transactionKind,
        command_transaction_id: record.transactionID,
        command_transaction_kind: record.transactionKind,
        violation: "scroll_command_outside_transaction",
        command_type: record.type,
        command_method: record.method,
        command_source: record.source,
        command_reason: record.reason,
      },
    })
  }

  const remember = (record: TimelineScrollCommandRecord) => {
    records.push(record)
    while (records.length > maxRecords) records.shift()
    maybeEmitTransactionViolation(record)
    emitDiagnostic({
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
        transaction_id: record.transactionID,
        transaction_kind: record.transactionKind,
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
    sinkTransaction?: TimelineScrollCommandTransaction,
  ) => {
    const fullMetrics = input?.fullMetricsEnabled?.() ?? false
    const before = fullMetrics ? collectTimelineScrollCommandMetrics(command.element) : undefined
    apply()
    const after = fullMetrics ? collectTimelineScrollCommandMetrics(command.element) : undefined
    const transaction = command.transaction ?? sinkTransaction ?? input?.transaction
    return remember({
      ...(input?.getContext?.() ?? {}),
      ...transaction,
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

  const makeSink = (sinkTransaction?: TimelineScrollCommandTransaction): TimelineScrollCommandSink => ({
    setScrollTop: (command) =>
      execute(
        command,
        "set-scroll-top",
        () => {
          command.element.scrollTop = command.top
        },
        sinkTransaction,
      ),
    scrollTo: (command) =>
      execute(
        command,
        "scroll-to",
        () => {
          command.element.scrollTo({ top: command.top, behavior: command.behavior })
        },
        sinkTransaction,
      ),
    records: () => [...records],
    withTransaction: (transaction) => makeSink(transaction),
  })

  return makeSink(input?.transaction)
}
