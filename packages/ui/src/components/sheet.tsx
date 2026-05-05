import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { ComponentProps, JSXElement, ParentProps, Show } from "solid-js"
import { useI18n } from "../context/i18n"
import { IconButton } from "./icon-button"

export type SheetSide = "right" | "left" | "top" | "bottom"

export interface SheetProps extends ParentProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: JSXElement
  footer?: JSXElement
  /** Which edge the sheet slides in from. Defaults to "right". */
  side?: SheetSide
  class?: ComponentProps<"div">["class"]
  classList?: ComponentProps<"div">["classList"]
}

export function Sheet(props: SheetProps) {
  const i18n = useI18n()
  return (
    <Kobalte
      modal
      open={props.open}
      onOpenChange={props.onOpenChange}
    >
      <Kobalte.Portal>
        {/* Reuse dialog-overlay CSS which provides var(--scrim-overlay) */}
        <Kobalte.Overlay data-component="dialog-overlay" />
        {/* data-component="sheet" + data-side are inside the Portal so CSS nesting works */}
        <div data-component="sheet" data-side={props.side ?? "right"}>
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
                <Kobalte.CloseButton
                  data-slot="sheet-close-button"
                  as={IconButton}
                  icon="close"
                  variant="ghost"
                  aria-label={i18n.t("ui.common.close")}
                />
              </div>
            </Show>
            <div data-slot="sheet-body">{props.children}</div>
            <Show when={props.footer}>
              <div data-slot="sheet-footer">{props.footer}</div>
            </Show>
          </Kobalte.Content>
        </div>
      </Kobalte.Portal>
    </Kobalte>
  )
}
