import { Global } from "../global"
import { Log } from "../util"
import path from "path"
import { rename, rm } from "fs/promises"
import z from "zod"
import { Installation } from "../installation"
import { Flag } from "../flag/flag"
import { lazy } from "@/util/lazy"
import { Filesystem } from "../util/filesystem"
import { Flock } from "../util/flock"
import { Hash } from "../util/hash"
import { withPawWorkProviders } from "./pawwork-providers"

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
  status: z.enum(["alpha", "beta", "deprecated"]).optional(),
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
    status: z.enum(["alpha", "beta", "deprecated"]).optional(),
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

function fresh() {
  return Date.now() - Number(Filesystem.stat(filepath)?.mtimeMs ?? 0) < ttl
}

function skip(force: boolean) {
  return !force && fresh()
}

const fetchApi = async () => {
  const result = await fetch(`${url()}/api.json`, {
    headers: { "User-Agent": Installation.USER_AGENT },
    signal: AbortSignal.timeout(10000),
  })
  return { ok: result.ok, text: await result.text() }
}

type Catalog = Record<string, Provider>

function parseCatalog(text: string): Catalog {
  const parsed = JSON.parse(text)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("models.dev catalog must be an object")
  }
  return PublishCatalog.parse(parsed) as unknown as Catalog
}

async function validateCatalog(catalog: Catalog) {
  const runtime = await import("./provider")
  const withLocalProviders = withPawWorkProviders(catalog)
  for (const provider of Object.values(withLocalProviders)) {
    runtime.fromModelsDevProvider(provider)
  }
}

async function atomicWriteFile(target: string, content: string) {
  const temp = `${target}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  try {
    await Filesystem.write(temp, content)
    await rename(temp, target)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
}

async function publishCandidate(text: string) {
  const catalog = parseCatalog(text)
  await validateCatalog(catalog)
  await atomicWriteFile(filepath, text)
  catalogVersion++
  Data.reset()
  return withPawWorkProviders(catalog)
}

async function loadCandidate(text: string) {
  const catalog = parseCatalog(text)
  await validateCatalog(catalog)
  return withPawWorkProviders(catalog)
}

export const Data = lazy(async () => {
  const overridePath = modelsPathOverride()
  const result = await Filesystem.readJson(overridePath ?? filepath).catch(() => {})
  if (result) return result
  // @ts-ignore
  const snapshot = await import("./models-snapshot.js")
    .then((m) => m.snapshot as Record<string, unknown>)
    .catch(() => undefined)
  if (snapshot) return snapshot
  if (Flag.OPENCODE_DISABLE_MODELS_FETCH) return {}
  return Flock.withLock(`models-dev:${filepath}`, async () => {
    const overridePath = modelsPathOverride()
    const result = await Filesystem.readJson(overridePath ?? filepath).catch(() => {})
    if (result) return result
    const result2 = await fetchApi()
    if (result2.ok) {
      try {
        const catalog = await loadCandidate(result2.text)
        try {
          await atomicWriteFile(filepath, result2.text)
          catalogVersion++
        } catch (e) {
          log.warn("failed to write initial models.dev catalog", { error: e })
        }
        return catalog
      } catch (e) {
        log.warn("failed to publish initial models.dev catalog", { error: e })
      }
    }
    return {}
  })
})

export async function get() {
  const result = await Data()
  return withPawWorkProviders(result as Record<string, Provider>)
}

export async function getWithVersion() {
  while (true) {
    const before = version()
    const result = await Data()
    const after = version()
    if (before === after) {
      return {
        providers: withPawWorkProviders(result as Record<string, Provider>),
        version: after,
      }
    }
    Data.reset()
  }
}

export async function refresh(force = false) {
  if (modelsPathOverride()) {
    catalogVersion++
    Data.reset()
    return
  }
  if (skip(force)) {
    catalogVersion++
    return Data.reset()
  }
  await Flock.withLock(`models-dev:${filepath}`, async () => {
    if (skip(force)) {
      catalogVersion++
      return Data.reset()
    }
    const result = await fetchApi()
    if (!result.ok) return
    await publishCandidate(result.text)
  }).catch((e) => {
    log.error("Failed to fetch models.dev", {
      error: e,
    })
  })
}

const ModelsDevModelValue = Model
const ModelsDevProviderValue = Provider
const ModelsDevDataValue = Data
const ModelsDevGetValue = get
const ModelsDevGetWithVersionValue = getWithVersion
const ModelsDevRefreshValue = refresh
const ModelsDevVersionValue = version

export namespace ModelsDev {
  export type Model = import("./models").Model
  export type Provider = import("./models").Provider

  export const Model = ModelsDevModelValue
  export const Provider = ModelsDevProviderValue
  export const Data = ModelsDevDataValue
  export const get = ModelsDevGetValue
  export const getWithVersion = ModelsDevGetWithVersionValue
  export const refresh = ModelsDevRefreshValue
  export const version = ModelsDevVersionValue
}

if (!Flag.OPENCODE_DISABLE_MODELS_FETCH && !process.argv.includes("--get-yargs-completions")) {
  void refresh()
  setInterval(
    async () => {
      await refresh()
    },
    60 * 1000 * 60,
  ).unref()
}
