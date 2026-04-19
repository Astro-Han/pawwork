import type { Component } from "solid-js"
import { ChartIcon, DocsIcon, PenIcon } from "@/components/design-icons"

export const pawworkSkillCards = [
  {
    name: "document-processing",
    Icon: DocsIcon as Component<{ class?: string }>,
    titleKey: "session.new.card.document.title",
    descriptionKey: "session.new.card.document.description",
  },
  {
    name: "data-analysis",
    Icon: ChartIcon as Component<{ class?: string }>,
    titleKey: "session.new.card.analysis.title",
    descriptionKey: "session.new.card.analysis.description",
  },
  {
    name: "writing-assistant",
    Icon: PenIcon as Component<{ class?: string }>,
    titleKey: "session.new.card.writing.title",
    descriptionKey: "session.new.card.writing.description",
  },
] as const

export type PawworkSkillName = (typeof pawworkSkillCards)[number]["name"]

export function getPawworkSkillMeta(skill?: string) {
  return pawworkSkillCards.find((item) => item.name === skill)
}
