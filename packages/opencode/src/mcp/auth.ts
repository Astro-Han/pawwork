import path from "path"
import z from "zod"
import { Global } from "@opencode-ai/core/global"
import { Effect, Layer, Context } from "effect"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { makeRuntime } from "@/effect/run-service"

export namespace McpAuth {
  export const Tokens = z.object({
    accessToken: z.string(),
    refreshToken: z.string().optional(),
    expiresAt: z.number().optional(),
    scope: z.string().optional(),
  })
  export type Tokens = z.infer<typeof Tokens>

  export const ClientInfo = z.object({
    clientId: z.string(),
    clientSecret: z.string().optional(),
    clientIdIssuedAt: z.number().optional(),
    clientSecretExpiresAt: z.number().optional(),
  })
  export type ClientInfo = z.infer<typeof ClientInfo>

  export const Entry = z.object({
    tokens: Tokens.optional(),
    clientInfo: ClientInfo.optional(),
    codeVerifier: z.string().optional(),
    oauthState: z.string().optional(),
    serverUrl: z.string().optional(),
  })
  export type Entry = z.infer<typeof Entry>

  const filepath = path.join(Global.Path.data, "mcp-auth.json")
  const lockKey = `mcp-auth:${filepath}`

  export interface Interface {
    readonly all: () => Effect.Effect<Record<string, Entry>>
    readonly get: (mcpName: string) => Effect.Effect<Entry | undefined>
    readonly getForUrl: (mcpName: string, serverUrl: string) => Effect.Effect<Entry | undefined>
    readonly set: (mcpName: string, entry: Entry, serverUrl?: string) => Effect.Effect<void>
    readonly remove: (mcpName: string) => Effect.Effect<void>
    readonly updateTokens: (mcpName: string, tokens: Tokens, serverUrl?: string) => Effect.Effect<void>
    readonly updateClientInfo: (mcpName: string, clientInfo: ClientInfo, serverUrl?: string) => Effect.Effect<void>
    readonly updateCodeVerifier: (mcpName: string, codeVerifier: string) => Effect.Effect<void>
    readonly clearCodeVerifier: (mcpName: string) => Effect.Effect<void>
    readonly updateOAuthState: (mcpName: string, oauthState: string) => Effect.Effect<void>
    readonly getOAuthState: (mcpName: string) => Effect.Effect<string | undefined>
    readonly clearOAuthState: (mcpName: string) => Effect.Effect<void>
    readonly isTokenExpired: (mcpName: string) => Effect.Effect<boolean | null>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/McpAuth") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* AppFileSystem.Service
      const flock = yield* EffectFlock.Service

      const read = Effect.fn("McpAuth.read")(function* () {
        return yield* fs.readJson(filepath).pipe(
          Effect.map((data) => data as Record<string, Entry>),
          Effect.catch(() => Effect.succeed({} as Record<string, Entry>)),
        )
      })

      const all = Effect.fn("McpAuth.all")(function* () {
        return yield* flock.withLock(read(), lockKey).pipe(Effect.orDie)
      })

      const get = Effect.fn("McpAuth.get")(function* (mcpName: string) {
        const data = yield* all()
        return data[mcpName]
      })

      const getForUrl = Effect.fn("McpAuth.getForUrl")(function* (mcpName: string, serverUrl: string) {
        const entry = yield* get(mcpName)
        if (!entry) return undefined
        if (!entry.serverUrl) return undefined
        if (entry.serverUrl !== serverUrl) return undefined
        return entry
      })

      const mutate = Effect.fn("McpAuth.mutate")(function* (
        update: (data: Record<string, Entry>) => Record<string, Entry> | undefined,
      ) {
        yield* flock.withLock(
          Effect.gen(function* () {
            const data = yield* read()
            const next = update(data)
            if (next) yield* fs.writeJson(filepath, next, 0o600).pipe(Effect.orDie)
          }),
          lockKey,
        ).pipe(Effect.orDie)
      })

      const set = Effect.fn("McpAuth.set")(function* (mcpName: string, entry: Entry, serverUrl?: string) {
        yield* mutate((data) => ({
          ...data,
          [mcpName]: serverUrl ? { ...entry, serverUrl } : { ...entry },
        }))
      })

      const remove = Effect.fn("McpAuth.remove")(function* (mcpName: string) {
        yield* mutate((data) => {
          const next = { ...data }
          delete next[mcpName]
          return next
        })
      })

      const updateField = <K extends keyof Entry>(field: K, spanName: string) =>
        Effect.fn(`McpAuth.${spanName}`)(function* (mcpName: string, value: NonNullable<Entry[K]>, serverUrl?: string) {
          yield* mutate((data) => {
            const entry = { ...(data[mcpName] ?? {}) }
            entry[field] = value
            if (serverUrl) entry.serverUrl = serverUrl
            return { ...data, [mcpName]: entry }
          })
        })

      const clearField = <K extends keyof Entry>(field: K, spanName: string) =>
        Effect.fn(`McpAuth.${spanName}`)(function* (mcpName: string) {
          yield* mutate((data) => {
            const current = data[mcpName]
            if (!current) return undefined
            const entry = { ...current }
            delete entry[field]
            return { ...data, [mcpName]: entry }
          })
        })

      const updateTokens = updateField("tokens", "updateTokens")
      const updateClientInfo = updateField("clientInfo", "updateClientInfo")
      const updateCodeVerifier = updateField("codeVerifier", "updateCodeVerifier")
      const updateOAuthState = updateField("oauthState", "updateOAuthState")
      const clearCodeVerifier = clearField("codeVerifier", "clearCodeVerifier")
      const clearOAuthState = clearField("oauthState", "clearOAuthState")

      const getOAuthState = Effect.fn("McpAuth.getOAuthState")(function* (mcpName: string) {
        const entry = yield* get(mcpName)
        return entry?.oauthState
      })

      const isTokenExpired = Effect.fn("McpAuth.isTokenExpired")(function* (mcpName: string) {
        const entry = yield* get(mcpName)
        if (!entry?.tokens) return null
        if (!entry.tokens.expiresAt) return false
        return entry.tokens.expiresAt < Date.now() / 1000
      })

      return Service.of({
        all,
        get,
        getForUrl,
        set,
        remove,
        updateTokens,
        updateClientInfo,
        updateCodeVerifier,
        clearCodeVerifier,
        updateOAuthState,
        getOAuthState,
        clearOAuthState,
        isTokenExpired,
      })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(EffectFlock.defaultLayer), Layer.provide(AppFileSystem.defaultLayer))

  const { runPromise } = makeRuntime(Service, defaultLayer)

  // Async facades for backward compat (used by McpOAuthProvider, CLI)

  export const get = async (mcpName: string) => runPromise((svc) => svc.get(mcpName))

  export const getForUrl = async (mcpName: string, serverUrl: string) =>
    runPromise((svc) => svc.getForUrl(mcpName, serverUrl))

  export const all = async () => runPromise((svc) => svc.all())

  export const set = async (mcpName: string, entry: Entry, serverUrl?: string) =>
    runPromise((svc) => svc.set(mcpName, entry, serverUrl))

  export const remove = async (mcpName: string) => runPromise((svc) => svc.remove(mcpName))

  export const updateTokens = async (mcpName: string, tokens: Tokens, serverUrl?: string) =>
    runPromise((svc) => svc.updateTokens(mcpName, tokens, serverUrl))

  export const updateClientInfo = async (mcpName: string, clientInfo: ClientInfo, serverUrl?: string) =>
    runPromise((svc) => svc.updateClientInfo(mcpName, clientInfo, serverUrl))

  export const updateCodeVerifier = async (mcpName: string, codeVerifier: string) =>
    runPromise((svc) => svc.updateCodeVerifier(mcpName, codeVerifier))

  export const updateOAuthState = async (mcpName: string, oauthState: string) =>
    runPromise((svc) => svc.updateOAuthState(mcpName, oauthState))
}
