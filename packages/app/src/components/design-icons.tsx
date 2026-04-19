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

function wrap18(children: JSX.Element, props: IconProps) {
  return (
    <div data-component="icon" data-size="medium" class={props.class}>
      <svg data-slot="icon-svg" viewBox="0 0 18 18" fill="none" aria-hidden="true">
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

export function DocsIcon(props: IconProps) {
  return wrap18(
    <>
      <path
        d="M4 2.5h6l3 3v10a1 1 0 01-1 1H4a1 1 0 01-1-1v-12a1 1 0 011-1z"
        stroke="currentColor"
        stroke-width="1.1"
        stroke-linejoin="round"
      />
      <path
        d="M10 2.5v3h3M5.5 9h7M5.5 11.5h7M5.5 14h4"
        stroke="currentColor"
        stroke-width="1.1"
        stroke-linecap="round"
      />
    </>,
    props,
  )
}

export function ChartIcon(props: IconProps) {
  return wrap18(
    <path
      d="M3 15V4M15 15H3M6 15V9M9.5 15V6.5M13 15v-4.5"
      stroke="currentColor"
      stroke-width="1.2"
      stroke-linecap="round"
    />,
    props,
  )
}

export function PenIcon(props: IconProps) {
  return wrap18(
    <>
      <path
        d="M3 15L4 12l8-8 3 3-8 8-3 0z"
        stroke="currentColor"
        stroke-width="1.1"
        stroke-linejoin="round"
      />
      <path d="M11 5l3 3" stroke="currentColor" stroke-width="1.1" />
    </>,
    props,
  )
}
