import type { IconProps } from "@opencode-ai/ui/icon"

export const pawworkSkillCards = [
  {
    name: "document-processing",
    iconName: "review" as IconProps["name"],
    titleKey: "session.new.card.document.title",
    descriptionKey: "session.new.card.document.description",
  },
  {
    name: "data-analysis",
    iconName: "code-lines" as IconProps["name"],
    titleKey: "session.new.card.analysis.title",
    descriptionKey: "session.new.card.analysis.description",
  },
  {
    name: "writing-assistant",
    iconName: "pencil-line" as IconProps["name"],
    titleKey: "session.new.card.writing.title",
    descriptionKey: "session.new.card.writing.description",
  },
] as const

export type PawworkSkillName = (typeof pawworkSkillCards)[number]["name"]

export function getPawworkSkillMeta(skill?: string) {
  return pawworkSkillCards.find((item) => item.name === skill)
}
