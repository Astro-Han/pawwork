import { createMemo } from "solid-js"
import type { Message as MessageType } from "@opencode-ai/sdk/v2"
import { SessionTurn } from "@opencode-ai/ui/session-turn"
import type { MessageComment } from "@/pages/session/message-timeline-comments"
import { MessageCommentList, messageComments } from "@/pages/session/message-timeline-comments"
import type { TurnChangeDisplay } from "@/pages/session/message-timeline-turn-changes"

/**
 * Slice 11b.1: per-turn row extracted from `message-timeline.tsx` per
 * design doc §3b.
 *
 *   `TimelineMessage` wraps a single user message id in:
 *      - an anchor div the scroll controller can target;
 *      - the comment chip rail (`MessageCommentList`);
 *      - the `SessionTurn` itself with its actions + setting flags.
 *
 *   `content-visibility: auto` is applied while the row is inactive so
 *   the browser can skip rendering work for off-screen turns; the row
 *   reservs a 500px intrinsic size so the scroll height stays stable.
 *
 * Inputs are deliberately pre-resolved values rather than accessors so
 * the parent owns reactivity granularity (one createMemo per message
 * id, computed once at the For boundary).
 */

type SessionStatus = Parameters<typeof SessionTurn>[0]["status"]
type UserActions = Parameters<typeof SessionTurn>[0]["actions"]
type TurnChangeActions = Parameters<typeof SessionTurn>[0]["turnChangeActions"]

export function TimelineMessage(props: {
  messageID: string
  anchorID: string
  centered: boolean
  parts: any[] | undefined
  active: boolean
  sessionID: string
  sessionMessages: MessageType[]
  actions: UserActions
  status: SessionStatus
  showReasoningSummaries: boolean
  turnChanges: Record<string, TurnChangeDisplay | null>
  turnChangeActions: TurnChangeActions
  onTrowLayoutInteraction?: () => void
}) {
  const comments = createMemo<MessageComment[]>(() => messageComments(props.parts ?? []), [], {
    equals: (a, b) =>
      a.length === b.length &&
      a.every(
        (c, i) =>
          c.path === b[i].path &&
          c.comment === b[i].comment &&
          c.selection?.startLine === b[i].selection?.startLine &&
          c.selection?.endLine === b[i].selection?.endLine,
      ),
  })

  return (
    <div
      id={props.anchorID}
      data-message-id={props.messageID}
      classList={{
        "min-w-0 w-full max-w-full": true,
        "md:max-w-[800px] 2xl:max-w-[1000px]": props.centered,
      }}
      style={{
        "content-visibility": props.active ? undefined : "auto",
        "contain-intrinsic-size": props.active ? undefined : "auto 500px",
      }}
    >
      <MessageCommentList comments={comments()} />
      <SessionTurn
        sessionID={props.sessionID}
        messageID={props.messageID}
        messages={props.sessionMessages}
        actions={props.actions}
        active={props.active}
        status={props.status}
        showReasoningSummaries={props.showReasoningSummaries}
        turnChanges={props.turnChanges}
        turnChangeActions={props.turnChangeActions}
        onTrowLayoutInteraction={props.onTrowLayoutInteraction}
        classes={{
          root: "min-w-0 w-full relative",
          content: "flex flex-col justify-between !overflow-visible",
          container: "w-full px-4 md:px-5",
        }}
      />
    </div>
  )
}
