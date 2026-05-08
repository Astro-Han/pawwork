import { type ComponentProps, splitProps } from "solid-js"

export function DockCard(props: ComponentProps<"div">) {
  const [split, rest] = splitProps(props, ["children", "class", "classList"])
  return (
    <div
      {...rest}
      data-dock="card"
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    >
      {split.children}
    </div>
  )
}

export function DockSegment(props: ComponentProps<"div">) {
  const [split, rest] = splitProps(props, ["children", "class", "classList"])
  return (
    <div
      {...rest}
      data-dock="segment"
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    >
      {split.children}
    </div>
  )
}

export function DockSegmentForm(props: ComponentProps<"form">) {
  const [split, rest] = splitProps(props, ["children", "class", "classList"])
  return (
    <form
      {...rest}
      data-dock="segment"
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    >
      {split.children}
    </form>
  )
}
