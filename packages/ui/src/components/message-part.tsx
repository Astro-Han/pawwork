import { Show } from "solid-js"
import type { AssistantMessage, UserMessage } from "@opencode-ai/sdk/v2"
import type { MessageProps } from "./message-part-types"
import { AssistantMessageDisplay } from "./assistant-message-display"
import { UserMessageDisplay } from "./user-message-display"

/**
 * Slice 11b.1: thin aggregator + public barrel for the message-part
 * surface.
 *
 *   - Hosts only the role dispatcher (`Message`); every concrete renderer
 *     lives in a sibling module and registers itself via side-effect.
 *   - Re-exports the public contract (types, registries, displays) so
 *     existing callers (session-turn.tsx, storybook fixtures, tests) keep
 *     working through the legacy import path.
 *   - Imports the side-effect modules in dependency order: registry,
 *     part renderers, then tool renderers. The order does not strictly
 *     matter because every registration is keyed by string, but keeping
 *     it deterministic makes hot-reload behaviour predictable.
 *
 * Companion modules (slice 11b.1):
 *   message-part-types.ts                 type-only contracts
 *   message-part-registry.tsx             PART_MAPPING + ToolRegistry + Part dispatcher
 *   message-part-markdown.tsx             paced streaming markdown helpers
 *   message-part-tool-info.ts             icon/title/subtitle/tone resolvers
 *   message-part-session-link.ts          child-session URL helpers
 *   message-part-render-groups.ts         legacy context-tool grouping
 *   message-part-group.ts                 v2 trow / prose / reasoning grouping
 *   message-part-tool-display.tsx         tool dispatcher + display chrome (registers "tool")
 *   message-part-core-renderers.tsx       text / reasoning / compaction (registers them)
 *   message-part-tools-basic.tsx          11 lightweight tool renderers
 *   message-part-tools-agent.tsx          task / agent renderer
 *   message-part-tools-shell.tsx          bash renderer
 *   message-part-tools-file.tsx           edit / write / apply_patch renderers
 *   assistant-message-display.tsx         assistant-side rendering
 *   user-message-display.tsx              user-side rendering
 */

// Public-surface re-exports — preserved so the legacy import path
// (`@/components/message-part`) keeps resolving for tests, stories, and
// the still-pending session-turn rewrite.
export type {
  MessagePartProps,
  MessageProps,
  PartComponent,
  SessionAction,
  ToolComponent,
  ToolProps,
  UserActions,
} from "./message-part-types"
export {
  PART_MAPPING,
  Part,
  registerPartComponent,
  registerTool,
  getTool,
  ToolRegistry,
} from "./message-part-registry"
export { buildToolInfo, type ToolInfo } from "./tool-info"
export { getToolInfo } from "./message-part-tool-info"
export { AssistantMessageDisplay, AssistantParts } from "./assistant-message-display"
export { UserMessageDisplay } from "./user-message-display"
export { MessageDivider } from "./message-part-core-renderers"

// Side-effect registrations — the order is dependency-driven but every
// registration is keyed by string so swapping any two imports here is
// safe.
import "./message-part-core-renderers"
import "./message-part-tool-display"
import "./message-part-tools-basic"
import "./message-part-tools-agent"
import "./message-part-tools-shell"
import "./message-part-tools-file"

export function Message(props: MessageProps) {
  return (
    <>
      <Show when={props.message.role === "user"}>
        <UserMessageDisplay message={props.message as UserMessage} parts={props.parts} actions={props.actions} />
      </Show>
      <Show when={props.message.role === "assistant"}>
        <AssistantMessageDisplay
          message={props.message as AssistantMessage}
          parts={props.parts}
          showAssistantCopyPartID={props.showAssistantCopyPartID}
          showReasoningSummaries={props.showReasoningSummaries}
        />
      </Show>
    </>
  )
}
