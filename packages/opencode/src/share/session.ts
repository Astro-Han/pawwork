import { Session } from "@/session"
import { SessionID } from "@/session/schema"
import { SyncEvent } from "@/sync"
import { Effect, Layer, Scope, Context } from "effect"
import { Config } from "../config/config"
import { Flag } from "@opencode-ai/core/flag/flag"
import { ShareNext } from "./share-next"
import { ShareRuntime } from "./runtime"

export namespace SessionShare {
  export interface Interface {
    readonly create: (input?: Session.CreateInput) => Effect.Effect<Session.Info>
    readonly share: (sessionID: SessionID) => Effect.Effect<{ url: string }, unknown>
    readonly unshare: (sessionID: SessionID) => Effect.Effect<void, unknown>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/SessionShare") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const cfg = yield* Config.Service
      const session = yield* Session.Service
      const shareNext = yield* ShareNext.Service
      const gate = yield* ShareRuntime.CloudShareGate
      const scope = yield* Scope.Scope

      // Local closure mirrors ShareRuntime.ensureEnabled — kept here so the captured `gate`
      // reference doesn't leak the CloudShareGate requirement into share/unshare/create's R type.
      // If you change the failure semantics here, mirror the change in runtime.ts.
      const ensureEnabled = Effect.suspend(() =>
        gate.isEnabled() ? Effect.void : Effect.fail(ShareRuntime.cloudShareDisabled()),
      )

      const share = Effect.fn("SessionShare.share")(function* (sessionID: SessionID) {
        yield* ensureEnabled
        const conf = yield* cfg.get()
        if (conf.share === "disabled") throw new Error("Sharing is disabled in configuration")
        const result = yield* shareNext.create(sessionID)
        yield* Effect.sync(() =>
          SyncEvent.run(Session.Event.Updated, { sessionID, info: { share: { url: result.url } } }),
        )
        return result
      })

      const unshare = Effect.fn("SessionShare.unshare")(function* (sessionID: SessionID) {
        yield* ensureEnabled
        yield* shareNext.remove(sessionID)
        yield* Effect.sync(() => SyncEvent.run(Session.Event.Updated, { sessionID, info: { share: { url: null } } }))
      })

      const create = Effect.fn("SessionShare.create")(function* (input?: Session.CreateInput) {
        const result = yield* session.create(input)
        if (result.parentID) return result
        if (!gate.isEnabled()) return result
        const conf = yield* cfg.get()
        if (!(Flag.OPENCODE_AUTO_SHARE || conf.share === "auto")) return result
        yield* share(result.id).pipe(Effect.ignore, Effect.forkIn(scope))
        return result
      })

      return Service.of({ create, share, unshare })
    }),
  )

  export const defaultLayer = Layer.suspend(() =>
    layer.pipe(
      Layer.provide(ShareNext.defaultLayer),
      Layer.provide(Session.defaultLayer),
      Layer.provide(Config.defaultLayer),
      Layer.provide(ShareRuntime.cloudShareGateDefaultLayer),
    ),
  )
}
