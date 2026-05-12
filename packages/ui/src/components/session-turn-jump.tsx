import { Show } from "solid-js"
import { Icon } from "./icon"
import "./session-turn-jump.css"

/**
 * Slice 11b.1 floating jump-to-bottom button.
 *
 * Per DESIGN.md L477 and W1 lock, this is a small round button that
 * appears above the composer dock whenever the user has scrolled up
 * from the bottom of the timeline. Geometry follows the icon-button
 * round floating variant: 30×30, `--surface-raised` fill, 1-px
 * `--border-weaker` hairline, `--shadow-floating`, hover 4% overlay,
 * `chevron-down` 16-px glyph.
 *
 * The visibility condition is a single signal: `!pinned`. The button is
 * shown the moment the user is no longer pinned to the bottom — no
 * "has new content since unlock" gate, no other state (slice 11b.1
 * §3.4 simplification, three-question principle).
 *
 * The component is presentational only — it does not own scroll state.
 * `useTimelineScroll` (packages/app/src/pages/session/) computes
 * `jumpButtonVisible` and `onJumpClick` and threads them in.
 */

export interface JumpToBottomProps {
  visible: boolean
  onClick: () => void
  /** Caller-resolved accessible label. */
  label: string
}

export function JumpToBottom(props: JumpToBottomProps) {
  return (
    <Show when={props.visible}>
      <button
        type="button"
        data-component="session-turn-jump"
        aria-label={props.label}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => props.onClick()}
      >
        <Icon name="chevron-down" />
      </button>
    </Show>
  )
}
