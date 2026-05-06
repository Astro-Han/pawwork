import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { ParentProps } from "solid-js"

export interface CommandPaletteProps extends ParentProps {
  transition?: boolean
  /** aria-label for the underlying Kobalte dialog content (a11y: WCAG 4.1.2). */
  label?: string
}

export function CommandPalette(props: CommandPaletteProps) {
  return (
    <div
      data-component="command-palette"
      data-transition={props.transition ? true : undefined}
    >
      <div data-slot="palette-container">
        <Kobalte.Content data-slot="palette-content" aria-label={props.label}>
          {props.children}
        </Kobalte.Content>
      </div>
    </div>
  )
}
