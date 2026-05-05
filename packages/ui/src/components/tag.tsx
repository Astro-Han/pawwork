import { type ComponentProps, splitProps } from "solid-js"

export interface TagProps extends ComponentProps<"span"> {}

export function Tag(props: TagProps) {
  const [split, rest] = splitProps(props, ["class", "classList", "children"])
  return (
    <span
      {...rest}
      data-component="tag"
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    >
      {split.children}
    </span>
  )
}
