import type { JSX } from "solid-js"

// Shared header geometry for composer dock widgets (Todo / Revert / Followup).
// DESIGN.md L305: collapsed height 36, 30 chev IconButton centered → 3px breathing.
// Caller owns label/preview content and chev props (rotation, data-attrs, handlers).
export function DockWidgetHeader(props: {
  ref?: (el: HTMLDivElement) => void
  children: JSX.Element
  chev: JSX.Element
  onToggle: () => void
  "data-action"?: string
}) {
  return (
    <div
      ref={props.ref}
      data-action={props["data-action"]}
      class="pl-3 pr-2 h-9 flex items-center gap-2 overflow-visible"
      role="button"
      tabIndex={0}
      onClick={props.onToggle}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        props.onToggle()
      }}
    >
      {props.children}
      <div class="ml-auto shrink-0">{props.chev}</div>
    </div>
  )
}
