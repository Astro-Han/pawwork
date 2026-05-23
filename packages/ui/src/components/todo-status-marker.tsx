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
// Both branches share one 16×16 inline-flex wrapper so the optional baseline
// nudge (marginTop) applies symmetrically regardless of state: putting it on
// the Icon would route it through splitProps onto the inner <svg> instead of
// the outer wrapper, and `align-items: center` on the wrapper would erase it.
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
   *
   * Callsite contract: passed as a static literal, not a reactive value. The
   * inline-style object is evaluated once per render and won't re-spread on
   * marginTop changes; if a future surface needs a dynamic nudge, wrap the
   * style in a getter (`style={() => ({...})}`) or promote the prop.
   */
  marginTop?: string
}

export function TodoStatusMarker(props: TodoStatusMarkerProps): JSX.Element {
  return (
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
      <Show
        when={props.status === "in_progress"}
        fallback={<Icon name={props.status === "completed" ? "circle-check" : "circle"} />}
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
      </Show>
    </span>
  )
}
