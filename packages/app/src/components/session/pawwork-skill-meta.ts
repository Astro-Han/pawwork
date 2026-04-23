import type { IconProps } from "@opencode-ai/ui/icon"
import type { JSX } from "solid-js"

type PawworkSkillCard = {
  readonly name: "document-processing" | "data-analysis" | "writing-assistant"
  readonly iconName: IconProps["name"]
  readonly homeIcon: IconProps["name"]
  readonly homeIconClass: string
  readonly homeIconStyle?: JSX.CSSProperties
  readonly titleKey: string
  readonly descriptionKey: string
}

// Writing accent (`#8B5FBF`) lives as inline style because Tailwind v4 is
// configured with `--color-*: initial`, so palette utilities like
// `text-violet-500` resolve to no CSS variable and render black.
export const pawworkSkillCards: readonly PawworkSkillCard[] = [
  {
    name: "document-processing",
    iconName: "doc-processing",
    homeIcon: "doc-processing",
    homeIconClass: "text-icon-warning-base",
    titleKey: "session.new.card.document.title",
    descriptionKey: "session.new.card.document.description",
  },
  {
    name: "data-analysis",
    iconName: "bar-chart",
    homeIcon: "bar-chart",
    homeIconClass: "text-icon-success-base",
    titleKey: "session.new.card.analysis.title",
    descriptionKey: "session.new.card.analysis.description",
  },
  {
    name: "writing-assistant",
    iconName: "pencil-line",
    homeIcon: "pencil-line",
    homeIconClass: "",
    homeIconStyle: { color: "#8B5FBF" },
    titleKey: "session.new.card.writing.title",
    descriptionKey: "session.new.card.writing.description",
  },
]

export type PawworkSkillName = PawworkSkillCard["name"]
