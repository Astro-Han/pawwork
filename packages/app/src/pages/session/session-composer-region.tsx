import type { ComponentProps } from "solid-js"
import { SessionComposerRegion, type createSessionComposerState } from "@/pages/session/composer"

type ComposerRegionProps = ComponentProps<typeof SessionComposerRegion>

export function SessionPageComposerRegion(props: {
  state: ReturnType<typeof createSessionComposerState>
  ready: boolean
  actionReady?: boolean
  abortReady?: boolean
  displaySessionID?: string
  displaySessionKey?: string
  centered: boolean
  inputRef: (el: HTMLDivElement) => void
  newSessionWorktree: string
  onNewSessionWorktreeReset: () => void
  onSubmit: () => void
  onResponseSubmit: () => void
  onModeChange?: (mode: "normal" | "shell") => void
  followup?: ComposerRegionProps["followup"]
  revert?: ComposerRegionProps["revert"]
  setPromptDockRef: (el: HTMLDivElement) => void
}) {
  return <SessionComposerRegion {...props} />
}
