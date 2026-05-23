import type { UserMessage } from "@opencode-ai/sdk/v2"
import {
  classifyTimelineRowMutation,
  createTimelineVirtualRows,
  type TimelineRowMutation,
  type TimelineVirtualRow,
} from "./timeline-virtual-rows"
import { chooseTimelineRowRenderMode, type TimelineRowRenderMode } from "./timeline-virtualization-strategy"

export type TimelineVisibleRange = {
  rendered_count: number
  visible_first_message_id: string | undefined
  visible_last_message_id: string | undefined
  signature: string
}

export type TimelineFrame = {
  visibleRange: TimelineVisibleRange
  rows: TimelineVirtualRow[]
  mutation: TimelineRowMutation
  renderMode: TimelineRowRenderMode
}

export const emptyTimelineVisibleRange: TimelineVisibleRange = {
  rendered_count: 0,
  visible_first_message_id: undefined,
  visible_last_message_id: undefined,
  signature: "0::",
}

export const emptyTimelineFrame: TimelineFrame = {
  visibleRange: emptyTimelineVisibleRange,
  rows: [],
  mutation: "same",
  renderMode: chooseTimelineRowRenderMode({ rowCount: 0 }),
}

export function createTimelineFrame(input: {
  previous: TimelineFrame | undefined
  messages: readonly UserMessage[]
  historyMore: boolean
  turnStart: number
}): TimelineFrame {
  const ids = input.messages.map((message) => message.id)
  const rows = createTimelineVirtualRows({
    messages: input.messages,
    historyMore: input.historyMore,
    turnStart: input.turnStart,
  })

  return {
    visibleRange: {
      rendered_count: ids.length,
      visible_first_message_id: ids[0],
      visible_last_message_id: ids.at(-1),
      signature: `${ids.length}:${ids[0] ?? ""}:${ids.at(-1) ?? ""}`,
    },
    rows,
    mutation: classifyTimelineRowMutation({ previous: input.previous?.rows ?? [], next: rows }),
    renderMode: chooseTimelineRowRenderMode({ rowCount: rows.length }),
  }
}

export function visibleRangeDataFromFrame(frame: TimelineFrame) {
  return {
    rendered_count: frame.visibleRange.rendered_count,
    visible_first_message_id: frame.visibleRange.visible_first_message_id,
    visible_last_message_id: frame.visibleRange.visible_last_message_id,
  }
}
