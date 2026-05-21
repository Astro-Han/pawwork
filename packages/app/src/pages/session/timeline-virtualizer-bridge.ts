import type { Accessor } from "solid-js"
import type { VirtualizerHandle } from "virtua/solid"
import type { TimelineVirtualRow } from "./timeline-virtual-rows"
import type { TimelineScrollCommandSink } from "./timeline-scroll-command-sink"

export type TimelineVirtualizerBridge = {
  setHandle: (handle: VirtualizerHandle | undefined) => void
  rowIndexForMessage: (messageID: string) => number | undefined
  scrollMessageNearTop: (input: {
    messageID: string
    viewport: HTMLElement | undefined
    behavior: ScrollBehavior
    sink: TimelineScrollCommandSink
    source: string
    reason: string
  }) => boolean
}

export function createTimelineVirtualizerBridge(input: {
  rows: Accessor<readonly TimelineVirtualRow[]>
}): TimelineVirtualizerBridge {
  let handle: VirtualizerHandle | undefined

  const rowIndexForMessage = (messageID: string) => {
    const index = input.rows().findIndex((row) => row.type === "message" && row.messageID === messageID)
    return index >= 0 ? index : undefined
  }

  return {
    setHandle: (next) => {
      handle = next
    },
    rowIndexForMessage,
    scrollMessageNearTop: (args) => {
      if (!handle || !args.viewport) return false
      const index = rowIndexForMessage(args.messageID)
      if (index === undefined) return false
      const sink: TimelineScrollCommandSink = args.sink
      sink.scrollTo({
        element: args.viewport,
        top: Math.max(0, handle.getItemOffset(index)),
        behavior: args.behavior,
        type: "target-message",
        source: args.source,
        reason: args.reason,
      })
      return true
    },
  }
}
