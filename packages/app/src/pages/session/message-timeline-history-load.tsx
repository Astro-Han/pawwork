import { Show } from "solid-js"
import { Button } from "@opencode-ai/ui/button"

/**
 * Slice 11b.1: "load earlier" rail extracted from `message-timeline.tsx`
 * per design doc §3b.
 *
 * Renders a single ghost button at the top of the timeline when there
 * are turns older than the current window. The button doubles as the
 * windowing indicator (`historyMore`) and the explicit "load earlier"
 * action — `props.show` should be true whenever either signal is set
 * on the parent.
 */

export function LoadEarlierButton(props: {
  show: boolean
  loading: boolean
  loadingLabel: string
  loadLabel: string
  onLoadEarlier: () => void
}) {
  return (
    <Show when={props.show}>
      <div class="w-full flex justify-center">
        <Button
          variant="ghost"
          size="large"
          class="text-13-medium opacity-50"
          disabled={props.loading}
          onClick={props.onLoadEarlier}
        >
          {props.loading ? props.loadingLabel : props.loadLabel}
        </Button>
      </div>
    </Show>
  )
}
