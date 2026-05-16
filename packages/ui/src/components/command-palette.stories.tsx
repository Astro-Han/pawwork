// @ts-nocheck
import { onMount } from "solid-js"
import * as mod from "./command-palette"
import { Button } from "./button"
import { useDialog } from "../context/dialog"

const docs = `### Overview
CommandPalette is a styled floating content shell for the \`⌘K\` command palette.
It renders inside the existing \`useDialog().show()\` mechanism — Portal, Overlay,
and Kobalte.Root are provided by \`context/dialog.tsx\`.

### API
- \`transition\`: enables enter/exit animation.
- \`label\`: aria-label for the underlying Kobalte dialog content (a11y: WCAG 4.1.2).
- \`children\`: typically a \`<List>\` component.

### Dimensions
- Width: \`min(640px, 100vw - 32px)\`
- Max height: \`min(480px, 100dvh - 32px)\` (viewport-clamped for small windows)
- Centered in the viewport.

### Theming/tokens
- Uses \`data-component="command-palette"\` and slot attributes.
- Shadow: \`--shadow-floating\` (not modal-shadow).

`

export default {
  title: "UI/CommandPalette",
  id: "components-command-palette",
  component: mod.CommandPalette,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component: docs,
      },
    },
  },
}

export const Basic = {
  render: () => {
    const dialog = useDialog()
    const open = () =>
      dialog.show(() => (
        <mod.CommandPalette label="Command palette">
          <div style={{ padding: "12px 16px", color: "var(--fg-base)" }}>
            Command palette content goes here.
          </div>
        </mod.CommandPalette>
      ))

    onMount(open)

    return (
      <Button variant="secondary" onClick={open}>
        Open command palette
      </Button>
    )
  },
}

export const WithTransition = {
  render: () => {
    const dialog = useDialog()
    return (
      <Button
        variant="secondary"
        onClick={() =>
          dialog.show(() => (
            <mod.CommandPalette transition label="Command palette">
              <div style={{ padding: "12px 16px", color: "var(--fg-base)" }}>
                Animated command palette content.
              </div>
            </mod.CommandPalette>
          ))
        }
      >
        Open with transition
      </Button>
    )
  },
}

export const WithMockItems = {
  render: () => {
    const dialog = useDialog()
    const items = [
      "New session",
      "Open file...",
      "Search sessions",
      "Settings",
      "Toggle sidebar",
    ]
    return (
      <Button
        variant="secondary"
        onClick={() =>
          dialog.show(() => (
            <mod.CommandPalette transition label="Command palette">
              <div style={{ "border-bottom": "1px solid var(--border-base)", padding: "10px 14px" }}>
                <input
                  placeholder="Search commands..."
                  style={{
                    width: "100%",
                    background: "transparent",
                    border: "none",
                    outline: "none",
                    color: "var(--fg-base)",
                    "font-size": "var(--font-size-body)",
                  }}
                />
              </div>
              <div style={{ padding: "4px 0" }}>
                {items.map((label) => (
                  <div
                    style={{
                      padding: "8px 14px",
                      cursor: "pointer",
                      "font-size": "var(--font-size-body)",
                      color: "var(--fg-base)",
                    }}
                  >
                    {label}
                  </div>
                ))}
              </div>
            </mod.CommandPalette>
          ))
        }
      >
        Open with mock items
      </Button>
    )
  },
}
