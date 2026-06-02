import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { Effect } from "effect"
import z from "zod"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionID, MessageID } from "@/session/schema"
import { ExternalResult } from "@/tool/external-result"
import { lazy } from "../../util/lazy"
import { Log } from "@opencode-ai/core/util/log"
import { AppRuntime } from "@/effect/app-runtime"

const log = Log.create({ service: "server" })

// Wire-format for one pending external-result trio. The app uses this to
// hydrate session / message / part stores during bootstrap so a parent-page
// reload can still surface a child agent's pending question. Without this
// endpoint the only signal that a question is pending is the
// `message.part.updated` SSE event, which is intentionally not in the
// event-replay buffer (high-volume streaming type), so any reload past the
// SSE cursor loses the dock. Served at `GET /external-result`.
const PendingExternalResult = z.object({
  session: Session.Info,
  message: MessageV2.Info,
  part: MessageV2.Part,
})

export const ExternalResultRoutes = lazy(() =>
  new Hono().get(
    "/",
    describeRoute({
      summary: "List pending external-result tool calls",
      description:
        "Return the (session, message, part) trio for every external-result Deferred currently awaiting a user response. Used by the app to hydrate the dock after reload / cold-open.",
      operationId: "externalResult.list",
      responses: {
        200: {
          description: "Pending external-result tool calls",
          content: {
            "application/json": {
              schema: resolver(PendingExternalResult.array()),
            },
          },
        },
      },
    }),
    async (c) => {
      const snapshots = ExternalResult.list()
      const out: Array<z.infer<typeof PendingExternalResult>> = []
      for (const snap of snapshots) {
        try {
          // Brand-narrow at the route boundary: ExternalResult holds raw
          // strings (it's a low-level module that can't depend on session
          // schema), so we coerce here using the canonical brand maker.
          const sessionID = SessionID.make(snap.sessionID)
          const messageID = MessageID.make(snap.messageID)
          const session = await AppRuntime.runPromise(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              return yield* sessions.get(sessionID)
            }),
          )
          // Brief retry for the register → updateToolCall race: ExternalResult
          // entry is set before processor.updateToolCall flushes the part row
          // to DB. Without the retry a reload that hits this millisecond
          // window returns no part; the dock can't recover from the next SSE
          // message.part.updated either because the child session/message
          // never made it into the store (part.updated reducer does not
          // upsert session info).
          let message = MessageV2.get({ sessionID, messageID })
          let part = message.parts.find((p) => p.type === "tool" && p.callID === snap.callID)
          for (let attempt = 0; !part && attempt < 3; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 50))
            message = MessageV2.get({ sessionID, messageID })
            part = message.parts.find((p) => p.type === "tool" && p.callID === snap.callID)
          }
          if (!part) continue
          out.push({ session, message: message.info, part })
        } catch (err) {
          // Session or message gone (deleted, forked away). Skip the entry;
          // the Deferred will resolve via its own abort path when the session
          // is destroyed.
          log.warn("external-result pending hydrate skipped", {
            sessionID: snap.sessionID,
            messageID: snap.messageID,
            callID: snap.callID,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      return c.json(out)
    },
  ),
)
