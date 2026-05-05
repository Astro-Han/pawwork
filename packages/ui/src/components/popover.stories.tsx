// @ts-nocheck
/**
 * Hover / active / focus-visible states are captured statically via
 * data-force-state="hover|active|focus-visible|selected|disabled" +
 * matching CSS rules in popover.css.
 */
import { createSignal } from "solid-js"
import * as mod from "./popover"
import { create } from "../storybook/scaffold"

const story = create({
  title: "UI/Popover",
  mod,
  args: {
    trigger: "Open popover",
    title: "Popover",
    description: "Optional description",
    defaultOpen: true,
    children: "Popover content",
  },
})

export default {
  title: "UI/Popover",
  id: "components-popover",
  component: story.meta.component,
  tags: ["autodocs"],
}

export const Basic = story.Basic

export const Inline = {
  args: {
    portal: false,
    defaultOpen: true,
  },
}

export const Controlled = {
  render: () => {
    const [open, setOpen] = createSignal(true)
    return (
      <mod.Popover
        open={open()}
        onOpenChange={setOpen}
        trigger="Toggle popover"
        title="Controlled"
        description="Open state is controlled"
      >
        Controlled content
      </mod.Popover>
    )
  },
}

/**
 * All item states side-by-side (light + dark).
 * Hover/focus/selected captured via data-force-state.
 */
export const MenuMatrix = {
  render: () => (
    <div style={{ display: "flex", gap: "16px", "align-items": "flex-start" }}>
      {/* Light */}
      <div
        style={{
          background: "var(--surface-base)",
          "border-radius": "var(--radius-md)",
          "box-shadow": "var(--ring-base), var(--shadow-floating)",
          padding: "4px",
          "min-width": "184px",
        }}
      >
        <div data-slot="popover-item">Default item</div>
        <div data-slot="popover-item" data-force-state="hover">
          Hovered item
        </div>
        <div data-slot="popover-item" data-force-state="active">
          Active item
        </div>
        <div data-slot="popover-item" data-force-state="focus-visible">
          Focused item
        </div>
        <div data-slot="popover-item" data-force-state="selected">
          Selected item
        </div>
        <div data-slot="popover-item" data-force-state="disabled">
          Disabled item
        </div>
        <div data-slot="popover-item">
          <span data-slot="popover-item-icon">⌘</span>
          With icon
          <span data-slot="popover-item-shortcut">⌘K</span>
        </div>
        <div data-slot="popover-separator" />
        <div data-slot="popover-item" data-variant="danger">
          Delete
        </div>
      </div>

      {/* Dark */}
      <div
        data-color-scheme="dark"
        style={{
          background: "var(--surface-base)",
          "border-radius": "var(--radius-md)",
          "box-shadow": "var(--ring-base), var(--shadow-floating)",
          padding: "4px",
          "min-width": "184px",
        }}
      >
        <div data-slot="popover-item">Default item</div>
        <div data-slot="popover-item" data-force-state="hover">
          Hovered item
        </div>
        <div data-slot="popover-item" data-force-state="selected">
          Selected item
        </div>
        <div data-slot="popover-item" data-force-state="disabled">
          Disabled item
        </div>
        <div data-slot="popover-separator" />
        <div data-slot="popover-item" data-variant="danger" data-force-state="hover">
          Delete (hover)
        </div>
      </div>
    </div>
  ),
}

export const WithDanger = {
  render: () => (
    <mod.Popover trigger="Open" defaultOpen portal={false}>
      <div data-slot="popover-item">Rename</div>
      <div data-slot="popover-item">Export…</div>
      <div data-slot="popover-separator" />
      <div data-slot="popover-item" data-variant="danger">
        Delete
      </div>
    </mod.Popover>
  ),
}
