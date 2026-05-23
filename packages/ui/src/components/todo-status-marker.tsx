import { Show, type JSX } from "solid-js"
import { Icon } from "./icon"

// Canonical visual for a todo's current state, used wherever PawWork renders a
// todo row: the composer dock (session-todo-dock), the message-part TodoWrite
// tool card, and the right-panel Status tab.
//
// - completed → 16×16 `circle-check` icon at `--icon-base`
// - pending / cancelled / any other value → 16×16 `circle` icon at `--icon-base`
// - in_progress → 13×13 ring inside a 16×16 box; `--border-weak` base with
//   `--brand-primary` top, animated by the shared `--animate-pw-spin` token
//
// DESIGN.md L201 forbids dots as state signals; this component is the single
// source of truth so any future change (size, palette, icon swap) propagates
// to all surfaces in one edit.
//
// `status` is typed as plain `string` because the SDK declares `Todo.status`
// that way (see packages/sdk/js/src/v2/gen/types.gen.ts). The runtime narrows
// safely: only the four documented values branch; anything else falls through
// to the `circle` outline, matching the long-standing behaviour of both
// session-todo-dock.tsx and todowrite.tsx.
export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled"

export interface TodoStatusMarkerProps {
  status: TodoStatus | (string & {})
  /**
   * Optional top nudge to align the 16×16 marker with the row's text baseline.
   * The composer dock and right-panel Status tab pass `"1px"` because they sit
   * next to body type at 13/130; the message-part TodoWrite card leaves this
   * unset because its row uses a different baseline.
   */
  marginTop?: string
}

export function TodoStatusMarker(props: TodoStatusMarkerProps): JSX.Element {
  return (
    <Show
      when={props.status === "in_progress"}
      fallback={
        <Icon
          name={props.status === "completed" ? "circle-check" : "circle"}
          style={{
            color: "var(--icon-base)",
            "flex-shrink": "0",
            ...(props.marginTop ? { "margin-top": props.marginTop } : {}),
          }}
        />
      }
    >
      <span
        style={{
          display: "inline-flex",
          "align-items": "center",
          "justify-content": "center",
          width: "16px",
          height: "16px",
          "flex-shrink": "0",
          ...(props.marginTop ? { "margin-top": props.marginTop } : {}),
        }}
      >
        <span
          style={{
            display: "inline-block",
            width: "13px",
            height: "13px",
            "border-radius": "9999px",
            border: "1.5px solid var(--border-weak)",
            "border-top-color": "var(--brand-primary)",
            animation: "var(--animate-pw-spin)",
          }}
        />
      </span>
    </Show>
  )
}
