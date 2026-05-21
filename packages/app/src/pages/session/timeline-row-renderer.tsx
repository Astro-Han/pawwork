import { createEffect, For, onCleanup, Show, type JSX } from "solid-js"
import { Virtualizer } from "virtua/solid"
import type { TimelineVirtualizerBridge } from "./timeline-virtualizer-bridge"
import type { TimelineVirtualRow } from "./timeline-virtual-rows"
import type { TimelineRowRenderMode } from "./timeline-virtualization-strategy"

export function TimelineRowRenderer(props: {
  mode: TimelineRowRenderMode
  rows: TimelineVirtualRow[]
  viewport: HTMLDivElement | undefined
  virtualizerBridge: TimelineVirtualizerBridge
  shift: boolean
  renderRow: (row: TimelineVirtualRow) => JSX.Element
}) {
  createEffect(() => {
    if (props.mode === "virtualized" && props.viewport) return
    props.virtualizerBridge.setHandle(undefined)
  })

  onCleanup(() => {
    props.virtualizerBridge.setHandle(undefined)
  })

  return (
    <Show when={props.mode === "plain"} fallback={<VirtualizedTimelineRows {...props} />}>
      <For each={props.rows}>{props.renderRow}</For>
    </Show>
  )
}

function VirtualizedTimelineRows(props: {
  rows: TimelineVirtualRow[]
  viewport: HTMLDivElement | undefined
  virtualizerBridge: TimelineVirtualizerBridge
  shift: boolean
  renderRow: (row: TimelineVirtualRow) => JSX.Element
}) {
  return (
    <Show when={props.viewport}>
      {(viewport) => (
        <Virtualizer
          ref={(handle) => props.virtualizerBridge.setHandle(handle)}
          data={props.rows}
          scrollRef={viewport()}
          shift={props.shift}
          overscan={8}
        >
          {props.renderRow}
        </Virtualizer>
      )}
    </Show>
  )
}
