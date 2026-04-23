import type { IconProps } from "@opencode-ai/ui/icon"
import type { SkillIconName } from "./skill-icons"

export const pawworkSkillCards = [
  {
    name: "document-processing",
    iconName: "folder" as IconProps["name"],
    homeIcon: "folder" as SkillIconName,
    homeIconClass: "text-icon-warning-base",
    titleKey: "session.new.card.document.title",
    descriptionKey: "session.new.card.document.description",
  },
  {
    name: "data-analysis",
    iconName: "status" as IconProps["name"],
    homeIcon: "bar-chart" as SkillIconName,
    homeIconClass: "text-icon-success-base",
    titleKey: "session.new.card.analysis.title",
    descriptionKey: "session.new.card.analysis.description",
  },
  {
    name: "writing-assistant",
    iconName: "pencil-line" as IconProps["name"],
    homeIcon: "pencil" as SkillIconName,
    homeIconClass: "text-violet-500",
    titleKey: "session.new.card.writing.title",
    descriptionKey: "session.new.card.writing.description",
  },
] as const

export type PawworkSkillName = (typeof pawworkSkillCards)[number]["name"]
