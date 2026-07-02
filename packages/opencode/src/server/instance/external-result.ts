import { Cause, Effect } from "effect"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionID, MessageID } from "@/session/schema"
import { ExternalResult } from "@/tool/external-result"
import { Log } from "@opencode-ai/core/util/log"

const log = Log.create({ service: "server" })

// Wire-format for one pending external-result trio. The app uses this to
// hydrate session / message / part stores during bootstrap so a parent-page
// reload can still surface a child agent's pending question. Without this
// endpoint the only signal that a question is pending is the
// `message.part.updated` SSE event, which is intentionally not in the
// event-replay buffer (high-volume streaming type), so any reload past the
// SSE cursor loses the dock. Served at `GET /external-result`.
type PendingExternalResult = {
  session: Session.Info
  message: MessageV2.Info
  part: MessageV2.Part
}

const readMessage = Effect.fn("ExternalResultRoutes.message.get")(function* (input: {
  sessionID: SessionID
  messageID: MessageID
}) {
  return yield* Effect.try({
    try: () => MessageV2.get(input),
    catch: (cause) => cause,
  })
})

const readMessageWithPendingToolPart = Effect.fn("ExternalResultRoutes.message.pendingToolPart")(function* (input: {
  sessionID: SessionID
  messageID: MessageID
  callID: string
}) {
  let message = yield* readMessage({ sessionID: input.sessionID, messageID: input.messageID })
  let part = message.parts.find((item) => item.type === "tool" && item.callID === input.callID)
  for (let attempt = 0; !part && attempt < 3; attempt++) {
    yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 50)))
    message = yield* readMessage({ sessionID: input.sessionID, messageID: input.messageID })
    part = message.parts.find((item) => item.type === "tool" && item.callID === input.callID)
  }
  if (!part) return
  return { message, part }
})

const hydratePendingExternalResult = Effect.fn("ExternalResultRoutes.hydrate")(function* (
  sessions: Session.Interface,
  snap: ExternalResult.PendingSnapshot,
) {
  // Brand-narrow at the route boundary: ExternalResult holds raw strings (it's
  // a low-level module that can't depend on session schema), so we coerce here
  // using the canonical brand maker.
  const sessionID = yield* Effect.try({
    try: () => SessionID.make(snap.sessionID),
    catch: (cause) => cause,
  })
  const messageID = yield* Effect.try({
    try: () => MessageID.make(snap.messageID),
    catch: (cause) => cause,
  })
  const session = yield* sessions.get(sessionID)
  // Brief retry for the register -> updateToolCall race: ExternalResult entry
  // is set before processor.updateToolCall flushes the part row to DB. Without
  // the retry a reload that hits this millisecond window returns no part; the
  // dock can't recover from the next SSE message.part.updated either because
  // the child session/message never made it into the store (part.updated
  // reducer does not upsert session info).
  const pending = yield* readMessageWithPendingToolPart({ sessionID, messageID, callID: snap.callID })
  if (!pending) return
  return { session, message: pending.message.info, part: pending.part } satisfies PendingExternalResult
})

export const listPendingExternalResults = Effect.fn("ExternalResultRoutes.list")(function* () {
  const sessions = yield* Session.Service
  const out: PendingExternalResult[] = []
  for (const snap of ExternalResult.list()) {
    const result = yield* hydratePendingExternalResult(sessions, snap).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          // Session or message gone (deleted, forked away). Skip the entry; the
          // Deferred will resolve via its own abort path when the session is
          // destroyed.
          const error = Cause.squash(cause)
          log.warn("external-result pending hydrate skipped", {
            sessionID: snap.sessionID,
            messageID: snap.messageID,
            callID: snap.callID,
            error: error instanceof Error ? error.message : String(error),
          })
          return undefined
        }),
      ),
    )
    if (result) out.push(result)
  }
  return out
})
