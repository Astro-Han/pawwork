// @ts-nocheck
import { createSignal, onMount } from "solid-js"
import * as mod from "./sheet"
import { Button } from "./button"

const docs = `### Overview
Sheet is a slide-in panel that enters from one of four edges (right, left, top, bottom).
It reuses the Dialog overlay scrim and Kobalte Dialog primitives.

### API
- \`open\`: boolean — controlled open state (required)
- \`onOpenChange\`: (open: boolean) => void — called when open state should change (required)
- \`side\`: "right" (default) | "left" | "top" | "bottom"
- Optional: \`title\`, \`footer\`, \`class\`, \`classList\`.

### Variants and states
- Four directional variants.
- Optional header (title + close button) and footer slots.

### Behavior
- Controlled component: caller manages open/close state via \`open\` and \`onOpenChange\`.

### Accessibility
- Close button in header when title is provided.
- Kobalte manages focus trap and aria attributes.
- Overlay scrim uses var(--scrim-overlay) token.

### Theming/tokens
- Uses \`data-component="sheet"\` and \`data-side\` for CSS targeting.
- Animations driven by \`--duration-slow\` token.

`

export default {
  title: "UI/Sheet",
  id: "components-sheet",
  component: mod.Sheet,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component: docs,
      },
    },
  },
}

export const RightDefault = {
  name: "Right (default)",
  render: () => {
    const [open, setOpen] = createSignal(false)
    onMount(() => setOpen(true))
    return (
      <>
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Open right sheet
        </Button>
        <mod.Sheet open={open()} onOpenChange={setOpen} title="Right Sheet" side="right">
          Sheet body content slides in from the right.
        </mod.Sheet>
      </>
    )
  },
}

export const LeftSheet = {
  name: "Left",
  render: () => {
    const [open, setOpen] = createSignal(false)
    return (
      <>
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Open left sheet
        </Button>
        <mod.Sheet open={open()} onOpenChange={setOpen} title="Left Sheet" side="left">
          Sheet body content slides in from the left.
        </mod.Sheet>
      </>
    )
  },
}

export const WithFooter = {
  name: "With Footer",
  render: () => {
    const [open, setOpen] = createSignal(false)
    onMount(() => setOpen(true))
    return (
      <>
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Open sheet with footer
        </Button>
        <mod.Sheet
          open={open()}
          onOpenChange={setOpen}
          title="Sheet with Footer"
          side="right"
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => setOpen(false)}>
                Confirm
              </Button>
            </>
          }
        >
          Sheet body content. The footer contains action buttons.
        </mod.Sheet>
      </>
    )
  },
}
