import type { JSX } from "solid-js"

// Shared header geometry for composer dock widgets (Todo / Revert / Followup).
// DESIGN.md L305 contract: collapsed height 36px, 30px chev IconButton
// centered → 3+3 breathing each side.
//
// h-[36px] is intentional, not h-9. This app sets root font-size to 13px via
// `html` uses `--font-size-body` in theme.css, so Tailwind's rem-based scale resolves h-9 to
// 2.25rem × 13 = 29.25px — short of the 30px IconButton, which would force the
// chev to overflow the row and clip against the segment's overflow-y: hidden.
// DESIGN.md contracts are absolute pixels, so absolute-pixel utilities are the
// honest mapping.
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
      class="pl-3 pr-2 h-[36px] flex items-center gap-2 overflow-visible"
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
      <div class="ml-auto shrink-0 flex items-center">{props.chev}</div>
    </div>
  )
}
