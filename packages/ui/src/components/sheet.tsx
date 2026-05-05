// useSheet context: future work; use with Kobalte.Root directly.
import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { ComponentProps, JSXElement, ParentProps, Show } from "solid-js"

export type SheetSide = "right" | "left" | "top" | "bottom"

export interface SheetProps extends ParentProps {
  title?: JSXElement
  footer?: JSXElement
  /** Which edge the sheet slides in from. Defaults to "right". */
  side?: SheetSide
  class?: ComponentProps<"div">["class"]
  classList?: ComponentProps<"div">["classList"]
}

export function Sheet(props: SheetProps) {
  return (
    <div
      data-component="sheet"
      data-side={props.side ?? "right"}
    >
      <div data-slot="sheet-container">
        <Kobalte.Content
          data-slot="sheet-content"
          classList={{
            ...props.classList,
            [props.class ?? ""]: !!props.class,
          }}
        >
          <Show when={props.title}>
            <div data-slot="sheet-header">
              <Kobalte.Title data-slot="sheet-title">{props.title}</Kobalte.Title>
              <Kobalte.CloseButton data-slot="sheet-close-button" />
            </div>
          </Show>
          <div data-slot="sheet-body">{props.children}</div>
          <Show when={props.footer}>
            <div data-slot="sheet-footer">{props.footer}</div>
          </Show>
        </Kobalte.Content>
      </div>
    </div>
  )
}
