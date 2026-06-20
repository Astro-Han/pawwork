import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Global } from "@opencode-ai/core/global"
import { Log } from "../util"
import path from "path"
import z from "zod"
import { Installation } from "../installation"
import { Flag } from "@opencode-ai/core/flag/flag"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { Hash } from "../util/hash"
import { withPawWorkProviders } from "./pawwork-providers"
import { Context, Effect, Layer, ManagedRuntime, Option } from "effect"
import { memoMap } from "@opencode-ai/core/effect/memo-map"

// Try to import bundled snapshot (generated at build time)
// Falls back to undefined in dev mode when snapshot doesn't exist
/* @ts-ignore */

const log = Log.create({ service: "models.dev" })
const source = url()
const filepath = path.join(
  Global.Path.cache,
  source === "https://models.dev" ? "models.json" : `models-${Hash.fast(source)}.json`,
)
const ttl = 5 * 60 * 1000
let catalogVersion = 0

type JsonValue = string | number | boolean | null | { [key: string]: JsonValue } | JsonValue[]

const JsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(JsonValue), z.record(z.string(), JsonValue)]),
)

const Cost = z.object({
  input: z.number(),
  output: z.number(),
  cache_read: z.number().optional(),
  cache_write: z.number().optional(),
  context_over_200k: z
    .object({
      input: z.number(),
      output: z.number(),
      cache_read: z.number().optional(),
      cache_write: z.number().optional(),
    })
    .optional(),
})

export const Model = z.object({
  id: z.string(),
  name: z.string(),
  family: z.string().optional(),
  release_date: z.string(),
  attachment: z.boolean(),
  reasoning: z.boolean(),
  temperature: z.boolean(),
  tool_call: z.boolean(),
  interleaved: z
    .union([
      z.literal(true),
      z
        .object({
          field: z.enum(["reasoning_content", "reasoning_details"]),
        })
        .strict(),
    ])
    .optional(),
  cost: Cost.optional(),
  limit: z.object({
    context: z.number(),
    input: z.number().optional(),
    output: z.number(),
  }),
  modalities: z
    .object({
      input: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
      output: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
    })
    .optional(),
  experimental: z
    .object({
      modes: z
        .record(
          z.string(),
          z.object({
            cost: Cost.optional(),
            provider: z
              .object({
                body: z.record(z.string(), JsonValue).optional(),
                headers: z.record(z.string(), z.string()).optional(),
              })
              .optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  status: z.enum(["alpha", "beta", "deprecated", "active"]).optional(),
  provider: z.object({ npm: z.string().optional(), api: z.string().optional() }).optional(),
})
export type Model = z.infer<typeof Model>

export const Provider = z.object({
  api: z.string().optional(),
  name: z.string(),
  env: z.array(z.string()),
  id: z.string(),
  npm: z.string().optional(),
  models: z.record(z.string(), Model),
})

export type Provider = z.infer<typeof Provider>

const PublishModel = z
  .object({
    id: z.string(),
    name: z.string(),
    family: z.string().optional(),
    release_date: z.string().optional(),
    attachment: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    temperature: z.boolean().optional(),
    tool_call: z.boolean().optional(),
    interleaved: z
      .union([
        z.literal(true),
        z
          .object({
            field: z.enum(["reasoning_content", "reasoning_details"]),
          })
          .strict(),
      ])
      .optional(),
    cost: Cost.optional(),
    limit: z.object({
      context: z.number(),
      input: z.number().optional(),
      output: z.number(),
    }),
    modalities: z
      .object({
        input: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
        output: z.array(z.enum(["text", "audio", "image", "video", "pdf"])),
      })
      .optional(),
    experimental: z
      .object({
        modes: z
          .record(
            z.string(),
            z.object({
              cost: Cost.optional(),
              provider: z
                .object({
                  body: z.record(z.string(), JsonValue).optional(),
                  headers: z.record(z.string(), z.string()).optional(),
                })
                .optional(),
            }),
          )
          .optional(),
      })
      .optional(),
    status: z.enum(["alpha", "beta", "deprecated", "active"]).optional(),
    provider: z.object({ npm: z.string().optional(), api: z.string().optional() }).optional(),
  })
  .passthrough()

const PublishProvider = z
  .object({
    api: z.string().optional(),
    name: z.string(),
    env: z.array(z.string()).optional(),
    id: z.string(),
    npm: z.string().optional(),
    models: z.record(z.string(), PublishModel),
  })
  .passthrough()

const PublishCatalog = z.record(z.string(), PublishProvider)

function url() {
  return Flag.OPENCODE_MODELS_URL || "https://models.dev"
}

function modelsPathOverride() {
  return process.env["OPENCODE_MODELS_PATH"]
}

export function version() {
  return catalogVersion
}

const fetchApi = Effect.fn("ModelsDev.fetchApi")(function* () {
  const result = yield* Effect.tryPromise(() =>
    fetch(`${url()}/api.json`, {
      headers: { "User-Agent": Installation.HTTP_USER_AGENT },
      signal: AbortSignal.timeout(10000),
    }),
  )
  return {
    ok: result.ok,
    text: yield* Effect.tryPromise(() => result.text()),
  }
})

type Catalog = Record<string, Provider>

export interface Interface {
  readonly data: () => Effect.Effect<Catalog, unknown>
  readonly reset: () => Effect.Effect<void>
  readonly refresh: (force?: boolean) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ModelsDev") {}

function cacheFresh(fs: AppFileSystem.Interface) {
  return fs.stat(filepath).pipe(
    Effect.map((info) => {
      const mtime = info.mtime.pipe(
        Option.map((date) => date.getTime()),
        Option.getOrElse(() => 0),
      )
      return Date.now() - mtime < ttl
    }),
    Effect.catch(() => Effect.succeed(false)),
  )
}

function skipCache(fs: AppFileSystem.Interface, force: boolean) {
  if (force) return Effect.succeed(false)
  return cacheFresh(fs)
}

function lockKey() {
  return `models-dev:${filepath}`
}

function readJsonOptional(fs: AppFileSystem.Interface, target: string) {
  return fs.readFileString(target).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => JSON.parse(text) as unknown,
        catch: (error) => error,
      }),
    ),
    Effect.catch(() => Effect.succeed(undefined)),
  )
}

function loadSnapshot() {
  return Effect.promise(async () => {
    // @ts-ignore generated at build time
    return import("./models-snapshot.js")
      .then((m) => m.snapshot as Record<string, unknown>)
      .catch(() => undefined)
  })
}

function atomicWriteFile(fs: AppFileSystem.Interface, target: string, content: string) {
  const temp = `${target}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  return Effect.gen(function* () {
    yield* fs.writeWithDirs(temp, content)
    yield* fs.rename(temp, target)
  }).pipe(Effect.ensuring(fs.remove(temp).pipe(Effect.ignore)))
}

function loadCandidate(text: string) {
  return Effect.gen(function* () {
    const catalog = yield* Effect.try({
      try: () => parseCatalog(text),
      catch: (error) => error,
    })
    const runtime = yield* Effect.tryPromise({
      try: () => import("./provider"),
      catch: (error) => error,
    })
    const withLocalProviders = withPawWorkProviders(catalog)
    yield* Effect.try({
      try: () => {
        for (const provider of Object.values(withLocalProviders)) {
          runtime.fromModelsDevProvider(provider)
        }
      },
      catch: (error) => error,
    })
    return withLocalProviders
  })
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const flock = yield* EffectFlock.Service

    const loadData = Effect.fn("ModelsDev.data.load")(function* () {
      const overridePath = modelsPathOverride()
      const result = yield* readJsonOptional(fs, overridePath ?? filepath)
      if (result) return result as Catalog
      const snapshot = yield* loadSnapshot()
      if (snapshot) return snapshot as Catalog
      if (Flag.OPENCODE_DISABLE_MODELS_FETCH) return {}

      return yield* flock.withLock(
        Effect.gen(function* () {
          const overridePath = modelsPathOverride()
          const result = yield* readJsonOptional(fs, overridePath ?? filepath)
          if (result) return result as Catalog
          const result2 = yield* fetchApi()
          if (!result2.ok) return {}

          return yield* loadCandidate(result2.text).pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                Effect.sync(() => {
                  log.warn("failed to publish initial models.dev catalog", { error })
                  return {}
                }),
              onSuccess: (catalog) =>
                Effect.gen(function* () {
                  yield* atomicWriteFile(fs, filepath, result2.text).pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        catalogVersion++
                      }),
                    ),
                    Effect.catch((error) =>
                      Effect.sync(() => {
                        log.warn("failed to write initial models.dev catalog", { error })
                      }),
                    ),
                  )
                  return catalog
                }),
            }),
          )
        }),
        lockKey(),
      )
    })

    let cachedData = yield* Effect.cached(loadData())

    const reset = Effect.fn("ModelsDev.reset")(function* () {
      cachedData = yield* Effect.cached(loadData())
    })

    const data = Effect.fn("ModelsDev.data")(function* () {
      return yield* cachedData
    })

    const publishCandidate = Effect.fn("ModelsDev.publishCandidate")(function* (text: string) {
      const catalog = yield* loadCandidate(text)
      yield* atomicWriteFile(fs, filepath, text)
      catalogVersion++
      yield* reset()
      return catalog
    })

    const refresh = Effect.fn("ModelsDev.refresh")(function* (force = false) {
      if (modelsPathOverride()) {
        catalogVersion++
        yield* reset()
        return
      }
      if (yield* skipCache(fs, force)) {
        catalogVersion++
        yield* reset()
        return
      }
      yield* flock
        .withLock(
          Effect.gen(function* () {
            if (yield* skipCache(fs, force)) {
              catalogVersion++
              yield* reset()
              return
            }
            const result = yield* fetchApi()
            if (!result.ok) return
            yield* publishCandidate(result.text)
          }),
          lockKey(),
        )
        .pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              log.error("Failed to fetch models.dev", { error })
            }),
          ),
        )
    })

    return Service.of({ data, reset, refresh })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(EffectFlock.defaultLayer), Layer.provide(AppFileSystem.defaultLayer))

function parseCatalog(text: string): Catalog {
  const parsed = JSON.parse(text)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("models.dev catalog must be an object")
  }
  return PublishCatalog.parse(parsed) as unknown as Catalog
}

const ModelsDevModelValue = Model
const ModelsDevProviderValue = Provider
const ModelsDevServiceValue = Service
const ModelsDevLayerValue = layer
const ModelsDevDefaultLayerValue = defaultLayer
const ModelsDevVersionValue = version

export namespace ModelsDev {
  export type Model = import("./models").Model
  export type Provider = import("./models").Provider
  export type Interface = import("./models").Interface

  export const Model = ModelsDevModelValue
  export const Provider = ModelsDevProviderValue
  export const Service = ModelsDevServiceValue
  export const layer = ModelsDevLayerValue
  export const defaultLayer = ModelsDevDefaultLayerValue
  export const version = ModelsDevVersionValue
}

const backgroundRuntime = ManagedRuntime.make(defaultLayer, { memoMap })
function refreshInBackground() {
  return backgroundRuntime.runPromise(Service.use((svc) => svc.refresh()))
}

if (!Flag.OPENCODE_DISABLE_MODELS_FETCH && !process.argv.includes("--get-yargs-completions")) {
  void refreshInBackground()
  setInterval(
    async () => {
      await refreshInBackground()
    },
    60 * 1000 * 60,
  ).unref()
}
