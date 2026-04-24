import { afterEach, expect, test } from "bun:test"
import { mkdir, readFile, rm, writeFile } from "fs/promises"
import path from "path"

import { tmpdir } from "../fixture/fixture"
import { makeRuntime } from "../../src/effect/run-service"
import { Env } from "../../src/env"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { ModelsDev, Provider } from "../../src/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Filesystem } from "../../src/util/filesystem"

const originalFetch = globalThis.fetch
const originalModelsPath = process.env.OPENCODE_MODELS_PATH
const originalWrite = Filesystem.write
const env = makeRuntime(Env.Service, Env.defaultLayer)
const setEnv = (key: string, value: string) => env.runSync((svc) => svc.set(key, value))

afterEach(async () => {
  globalThis.fetch = originalFetch
  ;(Filesystem as { write: typeof Filesystem.write }).write = originalWrite
  if (originalModelsPath === undefined) delete process.env.OPENCODE_MODELS_PATH
  else process.env.OPENCODE_MODELS_PATH = originalModelsPath
  ModelsDev.Data.reset()
  await rm(cachePath(), { force: true })
})

function cachePath() {
  return path.join(Global.Path.cache, "models.json")
}

async function writeCache(catalog: Record<string, unknown>) {
  await mkdir(path.dirname(cachePath()), { recursive: true })
  await writeFile(cachePath(), JSON.stringify(catalog))
}

async function readCacheText() {
  return await readFile(cachePath(), "utf8")
}

function asFetch(fn: (...args: Parameters<typeof fetch>) => Promise<Response>) {
  return fn as unknown as typeof fetch
}

function mockFetchWithCatalog(catalog: Record<string, unknown>) {
  globalThis.fetch = asFetch(async () => new Response(JSON.stringify(catalog), { status: 200 }))
}

function catalogWithModels(modelIDs: string[]) {
  return {
    "moonshotai-cn": {
      id: "moonshotai-cn",
      name: "Moonshot AI China",
      npm: "@ai-sdk/openai-compatible",
      api: "https://api.moonshot.cn/v1",
      env: ["MOONSHOT_API_KEY"],
      models: Object.fromEntries(modelIDs.map((id) => [id, model(id)])),
    },
  }
}

function model(id: string) {
  return {
    id,
    name: id,
    release_date: "2026-04-21",
    attachment: false,
    reasoning: false,
    temperature: true,
    tool_call: true,
    limit: { context: 128000, output: 4096 },
    modalities: { input: ["text"], output: ["text"] },
  }
}

async function withTestInstance(fn: () => Promise<void>) {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      setEnv("MOONSHOT_API_KEY", "test-key")
    },
    fn,
  })
}

const moonshotProviderID = ProviderID.make("moonshotai-cn")
const kimi26ModelID = ModelID.make("kimi-k2.6")

test("refresh publishes a valid candidate catalog", async () => {
  delete process.env.OPENCODE_MODELS_PATH
  await writeCache(catalogWithModels(["kimi-k2.5"]))
  mockFetchWithCatalog(catalogWithModels(["kimi-k2.5", "kimi-k2.6"]))

  const before = ModelsDev.version()
  await ModelsDev.refresh(true)

  expect(await readCacheText()).toContain("kimi-k2.6")
  expect(ModelsDev.version()).toBe(before + 1)
})

test("refresh keeps existing cache when candidate JSON is invalid", async () => {
  delete process.env.OPENCODE_MODELS_PATH
  await writeCache(catalogWithModels(["kimi-k2.5"]))
  const beforeCache = await readCacheText()
  const beforeVersion = ModelsDev.version()
  globalThis.fetch = asFetch(async () => new Response("not json", { status: 200 }))

  await ModelsDev.refresh(true)

  expect(await readCacheText()).toBe(beforeCache)
  expect(ModelsDev.version()).toBe(beforeVersion)
})

test("refresh keeps existing cache when candidate catalog cannot become runtime providers", async () => {
  delete process.env.OPENCODE_MODELS_PATH
  await writeCache(catalogWithModels(["kimi-k2.5"]))
  const beforeCache = await readCacheText()
  const beforeVersion = ModelsDev.version()
  const invalidCatalog: any = catalogWithModels(["kimi-k2.6"])
  delete invalidCatalog["moonshotai-cn"].models["kimi-k2.6"].limit
  mockFetchWithCatalog(invalidCatalog)

  await ModelsDev.refresh(true)

  expect(await readCacheText()).toBe(beforeCache)
  expect(ModelsDev.version()).toBe(beforeVersion)
})

test("refresh keeps existing cache when candidate catalog has invalid field types", async () => {
  delete process.env.OPENCODE_MODELS_PATH
  await writeCache(catalogWithModels(["kimi-k2.5"]))
  const beforeCache = await readCacheText()
  const beforeVersion = ModelsDev.version()
  const invalidCatalog: any = catalogWithModels(["kimi-k2.6"])
  invalidCatalog["moonshotai-cn"].models["kimi-k2.6"].temperature = "true"
  mockFetchWithCatalog(invalidCatalog)

  await ModelsDev.refresh(true)

  expect(await readCacheText()).toBe(beforeCache)
  expect(ModelsDev.version()).toBe(beforeVersion)
})

test("refresh keeps existing cache when network fetch fails", async () => {
  delete process.env.OPENCODE_MODELS_PATH
  await writeCache(catalogWithModels(["kimi-k2.5"]))
  const beforeCache = await readCacheText()
  const beforeVersion = ModelsDev.version()
  globalThis.fetch = asFetch(async () => {
    throw new Error("network down")
  })

  await expect(ModelsDev.refresh(true)).resolves.toBeUndefined()

  expect(await readCacheText()).toBe(beforeCache)
  expect(ModelsDev.version()).toBe(beforeVersion)
})

test("refresh keeps existing cache when HTTP response is not successful", async () => {
  delete process.env.OPENCODE_MODELS_PATH
  await writeCache(catalogWithModels(["kimi-k2.5"]))
  const beforeCache = await readCacheText()
  const beforeVersion = ModelsDev.version()
  globalThis.fetch = asFetch(async () => new Response("server down", { status: 500 }))

  await ModelsDev.refresh(true)

  expect(await readCacheText()).toBe(beforeCache)
  expect(ModelsDev.version()).toBe(beforeVersion)
})

test("refresh keeps existing cache when atomic publish write fails", async () => {
  delete process.env.OPENCODE_MODELS_PATH
  await writeCache(catalogWithModels(["kimi-k2.5"]))
  const beforeCache = await readCacheText()
  const beforeVersion = ModelsDev.version()
  mockFetchWithCatalog(catalogWithModels(["kimi-k2.5", "kimi-k2.6"]))
  ;(Filesystem as { write: typeof Filesystem.write }).write = async (target, content, mode) => {
    if (target.endsWith(".tmp")) throw new Error("write failed")
    return originalWrite(target, content, mode)
  }

  await ModelsDev.refresh(true)

  expect(await readCacheText()).toBe(beforeCache)
  expect(ModelsDev.version()).toBe(beforeVersion)
})

test("refresh does not publish to normal cache when models path override is set", async () => {
  await using tmp = await tmpdir()
  const overridePath = path.join(tmp.path, "models.json")
  await writeFile(overridePath, JSON.stringify(catalogWithModels(["kimi-k2.5"])))
  process.env.OPENCODE_MODELS_PATH = overridePath
  mockFetchWithCatalog(catalogWithModels(["kimi-k2.5", "kimi-k2.6"]))
  const beforeVersion = ModelsDev.version()

  await ModelsDev.refresh(true)

  await expect(readFile(cachePath(), "utf8")).rejects.toThrow()
  expect(ModelsDev.version()).toBe(beforeVersion + 1)
})

test("provider state rebuilds after models path override refresh", async () => {
  await using tmp = await tmpdir()
  const overridePath = path.join(tmp.path, "models.json")
  await writeFile(overridePath, JSON.stringify(catalogWithModels(["kimi-k2.5"])))
  process.env.OPENCODE_MODELS_PATH = overridePath
  ModelsDev.Data.reset()

  await withTestInstance(async () => {
    const before = await Provider.list()
    expect(before[moonshotProviderID]?.models[kimi26ModelID]).toBeUndefined()

    await writeFile(overridePath, JSON.stringify(catalogWithModels(["kimi-k2.5", "kimi-k2.6"])))
    await ModelsDev.refresh(true)

    const model = await Provider.getModel(moonshotProviderID, kimi26ModelID)
    expect(model.id).toBe(kimi26ModelID)
  })
})

test("provider state rebuilds after a successful catalog refresh", async () => {
  delete process.env.OPENCODE_MODELS_PATH
  await writeCache(catalogWithModels(["kimi-k2.5"]))
  ModelsDev.Data.reset()

  await withTestInstance(async () => {
    const before = await Provider.list()
    expect(before[moonshotProviderID]?.models[kimi26ModelID]).toBeUndefined()

    mockFetchWithCatalog(catalogWithModels(["kimi-k2.5", "kimi-k2.6"]))
    await ModelsDev.refresh(true)

    const model = await Provider.getModel(moonshotProviderID, kimi26ModelID)
    expect(model.id).toBe(kimi26ModelID)

    const after = await Provider.list()
    expect(after[moonshotProviderID]?.models[kimi26ModelID]).toBeDefined()
  })
})

test("provider state rebuilds when refresh observes an already fresh cache from another process", async () => {
  delete process.env.OPENCODE_MODELS_PATH
  await writeCache(catalogWithModels(["kimi-k2.5"]))
  ModelsDev.Data.reset()

  await withTestInstance(async () => {
    const before = await Provider.list()
    expect(before[moonshotProviderID]?.models[kimi26ModelID]).toBeUndefined()

    await writeCache(catalogWithModels(["kimi-k2.5", "kimi-k2.6"]))
    await ModelsDev.refresh(false)

    const model = await Provider.getModel(moonshotProviderID, kimi26ModelID)
    expect(model.id).toBe(kimi26ModelID)
  })
})

test("getLanguage reports ModelNotFoundError when refreshed catalog removes the provider", async () => {
  delete process.env.OPENCODE_MODELS_PATH
  await writeCache(catalogWithModels(["kimi-k2.5"]))
  ModelsDev.Data.reset()

  await withTestInstance(async () => {
    const oldModel = await Provider.getModel(moonshotProviderID, ModelID.make("kimi-k2.5"))

    mockFetchWithCatalog({})
    await ModelsDev.refresh(true)

    await expect(Provider.getLanguage(oldModel)).rejects.toThrow("ProviderModelNotFoundError")
  })
})

test("getLanguage reports provider suggestions after refreshed catalog replaces the provider", async () => {
  delete process.env.OPENCODE_MODELS_PATH
  await writeCache(catalogWithModels(["kimi-k2.5"]))
  ModelsDev.Data.reset()

  await withTestInstance(async () => {
    const oldModel = await Provider.getModel(moonshotProviderID, ModelID.make("kimi-k2.5"))
    mockFetchWithCatalog({
      "moonshotai-cn-next": {
        id: "moonshotai-cn-next",
        name: "Moonshot AI China Next",
        npm: "@ai-sdk/openai-compatible",
        api: "https://api.moonshot.cn/v1",
        env: ["MOONSHOT_API_KEY"],
        models: {
          "kimi-k2.6": model("kimi-k2.6"),
        },
      },
    })
    await ModelsDev.refresh(true)

    const error = await Provider.getLanguage(oldModel).catch((error) => error)
    expect(error.name).toBe("ProviderModelNotFoundError")
    expect(error.data).toMatchObject({
      providerID: moonshotProviderID,
      modelID: oldModel.id,
      suggestions: ["moonshotai-cn-next"],
    })
  })
})

test("connected provider overlay uses refreshed provider state", async () => {
  delete process.env.OPENCODE_MODELS_PATH
  await writeCache(catalogWithModels(["kimi-k2.5"]))
  ModelsDev.Data.reset()

  await withTestInstance(async () => {
    await Provider.list()

    mockFetchWithCatalog(catalogWithModels(["kimi-k2.5", "kimi-k2.6"]))
    await ModelsDev.refresh(true)

    const allProviders = await ModelsDev.get()
    const connected = await Provider.list()
    const merged = Object.assign(
      Object.fromEntries(
        Object.entries(allProviders).map(([id, provider]) => [id, Provider.fromModelsDevProvider(provider)]),
      ),
      connected,
    )

    expect(merged[moonshotProviderID]?.models[kimi26ModelID]).toBeDefined()
  })
})
