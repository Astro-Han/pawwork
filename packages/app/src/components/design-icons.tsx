import type { JSX } from "solid-js"

type IconProps = { class?: string }

function wrap(children: JSX.Element, props: IconProps) {
  return (
    <div data-component="icon" data-size="small" class={props.class}>
      <svg data-slot="icon-svg" viewBox="0 0 14 14" fill="none" aria-hidden="true">
        {children}
      </svg>
    </div>
  )
}

export function PaneL(props: IconProps) {
  return wrap(
    <>
      <rect x="2" y="2.5" width="10" height="9" rx="1.5" stroke="currentColor" stroke-width="1.1" />
      <path d="M5.5 2.5v9" stroke="currentColor" stroke-width="1.1" />
    </>,
    props,
  )
}

export function PaneR(props: IconProps) {
  return wrap(
    <>
      <rect x="2" y="2.5" width="10" height="9" rx="1.5" stroke="currentColor" stroke-width="1.1" />
      <path d="M8.5 2.5v9" stroke="currentColor" stroke-width="1.1" />
    </>,
    props,
  )
}
