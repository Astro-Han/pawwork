// @ts-nocheck
import * as mod from "./tag"
import { create } from "../storybook/scaffold"

const story = create({ title: "UI/Tag", mod, args: { children: "Label" } })

export default {
  title: "UI/Tag",
  id: "components-tag",
  component: story.meta.component,
  tags: ["autodocs"],
}

export const Basic = story.Basic

/**
 * Smoke-test Tag across common background surfaces.
 * All instances are rest-state only (no hover/focus/disabled).
 */
export const OnSurfaces = {
  render: () => (
    <div style={{ display: "flex", gap: "16px", "align-items": "center" }}>
      <div style={{ background: "var(--bg-base)", padding: "8px" }}>
        <mod.Tag>On white</mod.Tag>
      </div>
      <div style={{ background: "var(--bg-cream)", padding: "8px" }}>
        <mod.Tag>On cream</mod.Tag>
      </div>
      <div style={{ background: "var(--surface-raised)", padding: "8px" }}>
        <mod.Tag>On raised</mod.Tag>
      </div>
    </div>
  ),
}
