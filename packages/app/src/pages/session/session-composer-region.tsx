import type { ComponentProps } from "solid-js"
import type { PawworkSkillName } from "@/components/session/pawwork-skill-meta"
import { SessionComposerRegion, type createSessionComposerState } from "@/pages/session/composer"

type ComposerRegionProps = ComponentProps<typeof SessionComposerRegion>

export function SessionPageComposerRegion(props: {
  variant: "session" | "home"
  state: ReturnType<typeof createSessionComposerState>
  ready: boolean
  displaySessionID?: string
  displaySessionKey?: string
  centered: boolean
  inputRef: (el: HTMLDivElement) => void
  newSessionWorktree: string
  onNewSessionWorktreeReset: () => void
  onSubmit: () => void
  onResponseSubmit: () => void
  onModeChange?: (mode: "normal" | "shell") => void
  selectedSkill?: () => PawworkSkillName | undefined
  followup?: ComposerRegionProps["followup"]
  revert?: ComposerRegionProps["revert"]
  setPromptDockRef: (el: HTMLDivElement) => void
}) {
  return <SessionComposerRegion {...props} />
}
