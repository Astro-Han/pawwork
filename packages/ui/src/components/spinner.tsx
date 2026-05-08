import { ComponentProps } from "solid-js"

export function Spinner(props: {
  class?: string
  classList?: ComponentProps<"div">["classList"]
  style?: ComponentProps<"div">["style"]
  "aria-label"?: string
}) {
  return (
    <div
      data-component="spinner"
      role="status"
      aria-label={props["aria-label"] ?? "Loading"}
      classList={{
        ...props.classList,
        [props.class ?? ""]: !!props.class,
      }}
      style={props.style}
    />
  )
}
