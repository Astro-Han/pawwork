// @ts-nocheck
import * as mod from "./tooltip"
import { create } from "../storybook/scaffold"

const story = create({ title: "UI/Tooltip", mod, args: { value: "Tooltip", children: "Hover me" } })

export default {
  title: "UI/Tooltip",
  id: "components-tooltip",
  component: story.meta.component,
  tags: ["autodocs"],
}

export const Basic = story.Basic

export const Keybind = {
  render: () => (
    <mod.TooltipKeybind title="Search" keybind="⌘K">
      <span style={{ "text-decoration": "underline" }}>Hover for keybind</span>
    </mod.TooltipKeybind>
  ),
}

/** Force-open shows the inverse surface: --fg-strong bg + --bg-cream text. */
export const ForcedOpen = {
  args: {
    forceOpen: true,
    value: "Tooltip label",
    children: "Trigger",
  },
}

/**
 * All four placements × light + dark.
 * Tooltips are force-open for static screenshot coverage.
 */
export const Matrix = {
  render: () => (
    <div style={{ display: "flex", "flex-direction": "column", gap: "48px", padding: "32px" }}>
      {/* Light */}
      <div style={{ display: "flex", gap: "48px", "align-items": "center" }}>
        {(["top", "bottom", "left", "right"] as const).map((placement) => (
          <mod.Tooltip value={`${placement}`} placement={placement} forceOpen>
            <span style={{ padding: "4px", border: "1px solid var(--border-weak)" }}>
              {placement}
            </span>
          </mod.Tooltip>
        ))}
      </div>
      {/* Dark */}
      <div
        data-color-scheme="dark"
        style={{
          display: "flex",
          gap: "48px",
          "align-items": "center",
          background: "var(--bg-base)",
          padding: "16px",
        }}
      >
        {(["top", "bottom"] as const).map((placement) => (
          <mod.Tooltip value={`dark ${placement}`} placement={placement} forceOpen>
            <span style={{ padding: "4px", border: "1px solid var(--border-weak)", color: "var(--fg-strong)" }}>
              {placement}
            </span>
          </mod.Tooltip>
        ))}
      </div>
    </div>
  ),
}

export const Inactive = {
  args: {
    inactive: true,
    value: "Never shows",
    children: "Inactive trigger",
  },
}
