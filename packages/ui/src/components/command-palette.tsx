import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { ParentProps } from "solid-js"

export interface CommandPaletteProps extends ParentProps {
  transition?: boolean
}

export function CommandPalette(props: CommandPaletteProps) {
  return (
    <div
      data-component="command-palette"
      data-transition={props.transition ? true : undefined}
    >
      <div data-slot="palette-container">
        <Kobalte.Content data-slot="palette-content">
          {props.children}
        </Kobalte.Content>
      </div>
    </div>
  )
}
