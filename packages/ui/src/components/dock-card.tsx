import { type ComponentProps, splitProps } from "solid-js"

// SolidJS merges `class` and `classList` natively when both are passed —
// no manual concatenation. Earlier code used
// `classList={{ [split.class ?? ""]: !!split.class }}`, which collapses
// space-separated class strings into a single `classList` key and trips
// `Element.classList.toggle` (DOMException: InvalidCharacterError).

export function DockCard(props: ComponentProps<"div">) {
  const [split, rest] = splitProps(props, ["children", "class", "classList"])
  return (
    <div {...rest} data-dock="card" class={split.class} classList={split.classList}>
      {split.children}
    </div>
  )
}

export function DockSegment(props: ComponentProps<"div">) {
  const [split, rest] = splitProps(props, ["children", "class", "classList"])
  return (
    <div {...rest} data-dock="segment" class={split.class} classList={split.classList}>
      {split.children}
    </div>
  )
}

export function DockSegmentForm(props: ComponentProps<"form">) {
  const [split, rest] = splitProps(props, ["children", "class", "classList"])
  return (
    <form {...rest} data-dock="segment" class={split.class} classList={split.classList}>
      {split.children}
    </form>
  )
}
