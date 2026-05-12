import type { Component } from "solid-js"
import type { Message as MessageType, Part as PartType } from "@opencode-ai/sdk/v2"

/**
 * Slice 11b.1: types extracted from `message-part.tsx` so registry,
 * renderer, and tool files can import the shared shapes without
 * pulling in the heavier sibling modules' transitive graph.
 *
 * Kept as a pure type module — no runtime exports, no JSX, no Solid
 * primitive use. Adding non-type members would defeat the import-graph
 * decoupling and trigger transitive bundler entry through the registry
 * side-effect chain.
 */

export interface MessageProps {
  message: MessageType
  parts: PartType[]
  actions?: UserActions
  showAssistantCopyPartID?: string | null
  showReasoningSummaries?: boolean
}

export type SessionAction = (input: { sessionID: string; messageID: string }) => Promise<void> | void

export type UserActions = {
  fork?: SessionAction
  revert?: SessionAction
}

export interface MessagePartProps {
  part: PartType
  message: MessageType
  hideDetails?: boolean
  defaultOpen?: boolean
  showAssistantCopyPartID?: string | null
  turnDurationMs?: number
}

export type PartComponent = Component<MessagePartProps>

export interface ToolProps {
  input: Record<string, any>
  metadata: Record<string, any>
  tool: string
  output?: string
  status?: string
  hideDetails?: boolean
  defaultOpen?: boolean
  forceOpen?: boolean
  locked?: boolean
}

export type ToolComponent = Component<ToolProps>
