import { Context, Effect, Layer, Schema } from "effect"
import { Auth } from "../auth"
import { makeRuntime } from "../effect/run-service"
import * as McpExa from "./mcp-exa"

export namespace WebSearchAuth {
  export const AUTH_KEY = "pawwork:websearch:exa"

  export class MissingKeyError extends Schema.TaggedErrorClass<MissingKeyError>()("WebSearchAuthMissingKeyError", {
    message: Schema.String,
  }) {}

  export type Credential = McpExa.Credential
  export type Status = {
    source: Credential["source"]
    configured: boolean
    needsAttention: boolean
    quotaExceeded: boolean
  }

  export interface Interface {
    readonly credential: () => Effect.Effect<Credential, Auth.AuthError>
    readonly status: () => Effect.Effect<Status, Auth.AuthError>
    readonly saveKey: (key: string) => Effect.Effect<Status, Auth.AuthError | MissingKeyError>
    readonly removeKey: () => Effect.Effect<Status, Auth.AuthError>
    readonly markNeedsAttention: (failure: McpExa.Failure) => Effect.Effect<void, Auth.AuthError>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/WebSearchAuth") {}

  type SavedCredential = { source: "saved"; key: string }

  function savedCredential(info: Auth.Info | undefined): SavedCredential | undefined {
    if (!info || info.type !== "api") return
    const key = info.key.trim()
    if (!key) return
    return { source: "saved", key }
  }

  function statusFrom(info: Auth.Info | undefined): Status {
    const saved = savedCredential(info)
    if (saved) {
      const needsAttention = info?.type === "api" && info.metadata?.status === "needs_attention"
      return { source: "saved", configured: true, needsAttention, quotaExceeded: false }
    }
    const env = McpExa.credentialFromEnv()
    if (env.source === "env") return { source: "env", configured: true, needsAttention: false, quotaExceeded: false }
    return {
      source: "anonymous",
      configured: false,
      needsAttention: false,
      quotaExceeded: info?.type === "api" && info.metadata?.status === "quota_exceeded",
    }
  }

  export const layer: Layer.Layer<Service, never, Auth.Service> = Layer.effect(
    Service,
    Effect.gen(function* () {
      const auth = yield* Auth.Service

      const getSaved = () => auth.get(AUTH_KEY)

      const credential: Interface["credential"] = Effect.fn("WebSearchAuth.credential")(function* () {
        const saved = savedCredential(yield* getSaved())
        if (saved) return saved
        return McpExa.credentialFromEnv()
      })

      const status: Interface["status"] = Effect.fn("WebSearchAuth.status")(function* () {
        return statusFrom(yield* getSaved())
      })

      const saveKey: Interface["saveKey"] = Effect.fn("WebSearchAuth.saveKey")(function* (key: string) {
        const trimmed = key.trim()
        if (!trimmed) return yield* new MissingKeyError({ message: "Exa API key is required" })
        yield* auth.set(
          AUTH_KEY,
          new Auth.Api({
            type: "api",
            key: trimmed,
            metadata: { status: "configured" },
          }),
        )
        return yield* status()
      })

      const removeKey: Interface["removeKey"] = Effect.fn("WebSearchAuth.removeKey")(function* () {
        yield* auth.remove(AUTH_KEY)
        return yield* status()
      })

      const markNeedsAttention: Interface["markNeedsAttention"] = Effect.fn("WebSearchAuth.markNeedsAttention")(
        function* (failure: McpExa.Failure) {
          if (failure.kind !== "invalid_key" && failure.kind !== "quota_exceeded") return
          if (failure.source === "anonymous" && failure.kind === "quota_exceeded") {
            yield* auth.set(
              AUTH_KEY,
              new Auth.Api({
                type: "api",
                key: "",
                metadata: { status: "quota_exceeded", source: "anonymous" },
              }),
            )
            return
          }
          if (failure.source !== "saved") return
          const saved = yield* getSaved()
          if (!saved || saved.type !== "api") return
          yield* auth.set(
            AUTH_KEY,
            new Auth.Api({
              type: "api",
              key: saved.key,
              metadata: { ...saved.metadata, status: "needs_attention", reason: failure.kind },
            }),
          )
        },
      )

      return Service.of({ credential, status, saveKey, removeKey, markNeedsAttention })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(Auth.defaultLayer))

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function status() {
    return runPromise((svc) => svc.status())
  }

  export async function saveKey(key: string) {
    return runPromise((svc) => svc.saveKey(key))
  }

  export async function removeKey() {
    return runPromise((svc) => svc.removeKey())
  }
}
