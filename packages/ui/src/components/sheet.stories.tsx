// @ts-nocheck
import { onMount } from "solid-js"
import * as mod from "./sheet"
import { Button } from "./button"
import { useDialog } from "../context/dialog"

const docs = `### Overview
Sheet is a slide-in panel that enters from one of four edges (right, left, top, bottom).
It reuses the Dialog overlay scrim and Kobalte Dialog primitives.

### API
- \`side\`: "right" (default) | "left" | "top" | "bottom"
- Optional: \`title\`, \`footer\`, \`class\`, \`classList\`.

### Variants and states
- Four directional variants.
- Optional header (title + close button) and footer slots.

### Behavior
- Use with Kobalte.Root (Dialog.Root) for open/close state management.
- useSheet context is planned as future work.

### Accessibility
- Close button in header when title is provided.
- Kobalte manages focus trap and aria attributes.

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
    const dialog = useDialog()
    const open = () =>
      dialog.show(() => (
        <mod.Sheet title="Right Sheet">
          Sheet body content slides in from the right.
        </mod.Sheet>
      ))

    onMount(open)

    return (
      <Button variant="secondary" onClick={open}>
        Open right sheet
      </Button>
    )
  },
}

export const LeftSheet = {
  name: "Left",
  render: () => {
    const dialog = useDialog()
    return (
      <Button
        variant="secondary"
        onClick={() =>
          dialog.show(() => (
            <mod.Sheet title="Left Sheet" side="left">
              Sheet body content slides in from the left.
            </mod.Sheet>
          ))
        }
      >
        Open left sheet
      </Button>
    )
  },
}

export const WithFooter = {
  name: "With Footer",
  render: () => {
    const dialog = useDialog()
    const open = () =>
      dialog.show(() => (
        <mod.Sheet
          title="Sheet with Footer"
          side="right"
          footer={
            <>
              <Button variant="ghost" onClick={() => dialog.close()}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => dialog.close()}>
                Confirm
              </Button>
            </>
          }
        >
          Sheet body content. The footer contains action buttons.
        </mod.Sheet>
      ))

    onMount(open)

    return (
      <Button variant="secondary" onClick={open}>
        Open sheet with footer
      </Button>
    )
  },
}
