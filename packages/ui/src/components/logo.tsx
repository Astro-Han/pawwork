import { ComponentProps } from "solid-js"

const PawMarkShape = (props: { fill: string }) => {
  return (
    <g fill={props.fill}>
      <circle cx="24.8" cy="22" r="4.4" />
      <circle cx="39.2" cy="22" r="4.4" />
      <circle cx="18.3" cy="30.75" r="3.8" />
      <circle cx="45.75" cy="30.75" r="3.8" />
      <path d="M32 29.2 C24.2 29.2 19.8 37.6 19.8 42.6 C19.8 46.4 23.3 47.9 28.3 46.1 C30.1 45.4 33.9 45.4 35.8 46.1 C40.8 47.9 44.2 46.4 44.2 42.6 C44.2 37.6 39.8 29.2 32 29.2 Z" />
    </g>
  )
}

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <PawMarkShape fill="var(--icon-strong-base)" />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <PawMarkShape fill="var(--icon-base)" />
    </svg>
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      data-component="logo"
      viewBox="0 0 64 64"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <PawMarkShape fill="var(--icon-strong-base)" />
    </svg>
  )
}
