import type { PawworkSkillName } from "@/components/session/pawwork-skill-meta"

type PromptPlaceholderInput = {
  mode: "normal" | "shell"
  commentCount: number
  example: string
  suggest: boolean
  selectedSkill?: PawworkSkillName
  t: (key: string, params?: Record<string, string>) => string
}

const SKILL_PLACEHOLDER_KEY: Record<PawworkSkillName, string> = {
  "document-processing": "session.new.placeholder.document",
  "data-analysis": "session.new.placeholder.analysis",
  "writing-assistant": "session.new.placeholder.writing",
}

export function promptPlaceholder(input: PromptPlaceholderInput) {
  if (input.mode === "shell") return input.t("prompt.placeholder.shell")
  if (input.commentCount > 1) return input.t("prompt.placeholder.summarizeComments")
  if (input.commentCount === 1) return input.t("prompt.placeholder.summarizeComment")
  if (input.selectedSkill) return input.t(SKILL_PLACEHOLDER_KEY[input.selectedSkill])
  if (!input.suggest) return input.t("prompt.placeholder.simple")
  return input.t("prompt.placeholder.normal", { example: input.example })
}
