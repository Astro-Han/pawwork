import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect"
import { SessionID } from "./schema"
import { RetryClassification } from "./retry-classification"
import { Effect, Layer, Context } from "effect"
import z from "zod"

export const Info = z
  .discriminatedUnion("type", [
    z.object({
      type: z.literal("idle"),
    }),
    z.object({
      type: z.literal("retry"),
      attempt: z.number(),
      message: z.string(),
      next: z.number(),
      // optional: populated when the retry is caused by a classifiable rate-limit error
      classification: RetryClassification.optional(),
    }),
    z.object({
      type: z.literal("busy"),
    }),
    z.object({
      // terminal state: rate limit cannot be retried (e.g. free_quota_exhausted)
      type: z.literal("rate_limit_blocked"),
      classification: RetryClassification,
    }),
  ])
  .meta({
    ref: "SessionStatus",
  })
export type Info = z.infer<typeof Info>

export const Event = {
  Status: BusEvent.define(
    "session.status",
    z.object({
      sessionID: SessionID.zod,
      status: Info,
    }),
  ),
  // deprecated
  Idle: BusEvent.define(
    "session.idle",
    z.object({
      sessionID: SessionID.zod,
    }),
  ),
}

export interface Interface {
  readonly get: (sessionID: SessionID) => Effect.Effect<Info>
  readonly list: () => Effect.Effect<Map<SessionID, Info>>
  readonly set: (sessionID: SessionID, status: Info) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionStatus") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    const state = yield* InstanceState.make(
      Effect.fn("SessionStatus.state")(() => Effect.succeed(new Map<SessionID, Info>())),
    )

    const get = Effect.fn("SessionStatus.get")(function* (sessionID: SessionID) {
      const data = yield* InstanceState.get(state)
      return data.get(sessionID) ?? { type: "idle" as const }
    })

    const list = Effect.fn("SessionStatus.list")(function* () {
      return new Map(yield* InstanceState.get(state))
    })

    const set = Effect.fn("SessionStatus.set")(function* (sessionID: SessionID, status: Info) {
      const data = yield* InstanceState.get(state)
      // rate_limit_blocked is a sticky terminal state. The runner's onIdle hook
      // (run-state.ts) fires after the processor returns "stop", which would
      // otherwise clobber the blocked status back to idle and the UI would
      // never see the RateLimitCard. Only an explicit non-idle transition
      // (e.g. user sends a new prompt → busy) is allowed to leave the state.
      if (status.type === "idle" && data.get(sessionID)?.type === "rate_limit_blocked") {
        return
      }
      yield* bus.publish(Event.Status, { sessionID, status })
      if (status.type === "idle") {
        yield* bus.publish(Event.Idle, { sessionID })
        data.delete(sessionID)
        return
      }
      data.set(sessionID, status)
    })

    return Service.of({ get, list, set })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as SessionStatus from "./status"
