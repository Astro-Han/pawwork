import type { JSX } from "solid-js"

// Shared chrome for every Overview section. Kept in its own module so the
// per-section files (git, artifact, ...) can import it without taking a
// dependency on the top-level composition, which itself imports back from
// each section file.
export function Section(props: { title: string; children: JSX.Element }) {
  return (
    <div class="flex flex-col gap-2 px-4 py-6">
      <div class="text-caption text-fg-weak">{props.title}</div>
      {props.children}
    </div>
  )
}

export function Empty(props: { text: string }) {
  return <div class="text-body text-fg-weaker">{props.text}</div>
}
