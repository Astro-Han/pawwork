import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import type { SessionStatusState } from "@/context/global-sync/types"

export type SubmitMode = "normal" | "shell"

export function commandLikeText(text: string) {
  return text.startsWith("/")
}

export function canSubmitPrompt(input: {
  mode: SubmitMode
  text: string
  submitReady: boolean
  commandsReady: boolean
}) {
  if (!input.submitReady) return false
  if (input.mode !== "normal") return true
  if (!commandLikeText(input.text)) return true
  return input.commandsReady
}

export function canSendFollowupDraft(input: { draft: { text: string }; submitReady: boolean; commandsReady: boolean }) {
  return canSubmitPrompt({
    mode: "normal",
    text: input.draft.text,
    submitReady: input.submitReady,
    commandsReady: input.commandsReady,
  })
}

export function currentSessionCacheReady(input: {
  sessionID: string | undefined
  sessionInfo: unknown
  rawMessages: unknown
}) {
  if (!input.sessionID) return true
  return input.sessionInfo !== undefined && input.rawMessages !== undefined
}

export function currentSessionActionReady(input: {
  sessionID: string | undefined
  sessionInfo: unknown
  rawMessages: unknown
  statusReady: boolean
}) {
  if (!input.sessionID) return true
  return currentSessionCacheReady(input) && input.statusReady
}

export function currentSessionSubmitReady(input: {
  sessionID: string | undefined
  sessionInfo: unknown
  rawMessages: unknown
  statusReady: boolean
  localReady: boolean
  providerUsable: boolean
}) {
  return currentSessionActionReady(input) && input.localReady && input.providerUsable
}

export function currentWorkspaceSubmitReady(input: { localReady: boolean; providerUsable: boolean }) {
  return input.localReady && input.providerUsable
}

export function currentDirectoryProviderUsable(input: { providerReady: boolean; providerCount: number }) {
  return input.providerReady || input.providerCount > 0
}

export function sessionStatusKnown(input: { statusState: SessionStatusState; status: SessionStatus | undefined }) {
  if (input.statusState === "ready" || input.statusState === "error") return true
  return input.status?.type === "busy" || input.status?.type === "retry"
}
