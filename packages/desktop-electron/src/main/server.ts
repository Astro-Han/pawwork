import { app } from "electron"
import path from "node:path"
import { DEFAULT_SERVER_URL_KEY, WSL_ENABLED_KEY } from "./constants"
import { rendererOrigin } from "./renderer-protocol"
import { PAWWORK_RUNTIME, runtimeRoots } from "./runtime-namespace"
import { getUserShell, loadShellEnv } from "./shell-env"
import { getStore } from "./store"

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
] as const

export type WslConfig = { enabled: boolean }

export type HealthCheck = { wait: Promise<void> }

type ProxyDispatcherModule = {
  EnvHttpProxyAgent: new (options: { httpProxy?: string; httpsProxy?: string; noProxy?: string }) => unknown
  setGlobalDispatcher(dispatcher: unknown): void
}

type ProxyConfig = {
  httpProxy?: string
  httpsProxy?: string
  noProxy?: string
}

export function getDefaultServerUrl(): string | null {
  const value = getStore().get(DEFAULT_SERVER_URL_KEY)
  return typeof value === "string" ? value : null
}

export function setDefaultServerUrl(url: string | null) {
  if (url) {
    getStore().set(DEFAULT_SERVER_URL_KEY, url)
    return
  }

  getStore().delete(DEFAULT_SERVER_URL_KEY)
}

export function getWslConfig(): WslConfig {
  const value = getStore().get(WSL_ENABLED_KEY)
  return { enabled: typeof value === "boolean" ? value : false }
}

export function setWslConfig(config: WslConfig) {
  getStore().set(WSL_ENABLED_KEY, config.enabled)
}

export async function spawnLocalServer(hostname: string, port: number, password: string) {
  prepareServerEnv(password)
  await configureProxyDispatcher(process.env)
  const { Log, Server } = await import("virtual:opencode-server")
  await Log.init({ print: false, level: "WARN" })
  const listener = await Server.listen({
    port,
    hostname,
    cors: [rendererOrigin],
  })

  const wait = (async () => {
    const url = `http://${hostname}:${port}`

    const ready = async () => {
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        if (await checkHealth(url, password)) return
      }
    }

    await ready()
  })()

  return { listener, health: { wait } }
}

function githubConfigDir(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  pathUtils: Pick<typeof path, "join"> = path,
) {
  if (env.GH_CONFIG_DIR) return env.GH_CONFIG_DIR
  if (env.XDG_CONFIG_HOME) return pathUtils.join(env.XDG_CONFIG_HOME, "gh")
  const appData = env.AppData ?? env.APPDATA ?? (platform === "win32" ? env.appdata : undefined)
  if (platform === "win32" && appData) return pathUtils.join(appData, "GitHub CLI")
  if (env.HOME) return pathUtils.join(env.HOME, ".config", "gh")
  return undefined
}

function buildServerEnv(password: string) {
  const shell = process.platform === "win32" ? null : getUserShell()
  const shellEnv = shell ? (loadShellEnv(shell) ?? {}) : {}
  const roots = runtimeRoots(app.getPath("userData"))
  const originalEnv = { ...shellEnv, ...process.env }
  const ghConfigDir = githubConfigDir(originalEnv, process.platform)
  const mergedEnv = {
    ...originalEnv,
    ...(shellEnv.PATH ? { PATH: shellEnv.PATH } : {}),
  }
  return {
    ...mergedEnv,
    OPENCODE_EXPERIMENTAL_ICON_DISCOVERY: "true",
    OPENCODE_EXPERIMENTAL_FILEWATCHER: "true",
    OPENCODE_CLIENT: PAWWORK_RUNTIME.client,
    OPENCODE_SERVER_USERNAME: PAWWORK_RUNTIME.serverUsername,
    OPENCODE_SERVER_PASSWORD: password,
    PAWWORK_RUNTIME_NAMESPACE: "pawwork",
    ...(ghConfigDir ? { GH_CONFIG_DIR: ghConfigDir } : {}),
    XDG_DATA_HOME: roots.data,
    XDG_CACHE_HOME: roots.cache,
    XDG_CONFIG_HOME: roots.config,
    XDG_STATE_HOME: roots.state,
  }
}

function prepareServerEnv(password: string) {
  // Mutates the current process because the embedded server is imported in-process and reads env at module load.
  Object.assign(process.env, buildServerEnv(password))
}

function proxyConfigFromEnv(env: NodeJS.ProcessEnv): ProxyConfig | null {
  const allProxy = env.ALL_PROXY ?? env.all_proxy
  const httpProxy = env.HTTP_PROXY ?? env.http_proxy ?? allProxy
  const httpsProxy = env.HTTPS_PROXY ?? env.https_proxy ?? allProxy
  const noProxy = env.NO_PROXY ?? env.no_proxy
  if (!httpProxy && !httpsProxy) return null
  return { httpProxy, httpsProxy, noProxy }
}

function presentProxyEnvKeys(env: NodeJS.ProcessEnv) {
  return PROXY_ENV_KEYS.filter((key) => Boolean(env[key]))
}

function supportedProxyUrl(url: string | undefined) {
  if (!url) return undefined
  try {
    const protocol = new URL(url).protocol
    if (protocol === "http:" || protocol === "https:") return url
    return undefined
  } catch {
    return undefined
  }
}

function normalizeProxyConfig(proxy: ProxyConfig) {
  const httpProxy = supportedProxyUrl(proxy.httpProxy)
  const httpsProxy = supportedProxyUrl(proxy.httpsProxy)
  const skipped = {
    httpProxy: Boolean(proxy.httpProxy && !httpProxy),
    httpsProxy: Boolean(proxy.httpsProxy && !httpsProxy),
  }
  if (!httpProxy && !httpsProxy) {
    return {
      proxy: null,
      skipped,
    }
  }
  return {
    proxy: {
      httpProxy,
      httpsProxy,
      noProxy: proxy.noProxy,
    },
    skipped,
  }
}

async function configureProxyDispatcher(
  env: NodeJS.ProcessEnv,
  load: () => Promise<ProxyDispatcherModule> = () => import("undici"),
) {
  const proxy = proxyConfigFromEnv(env)
  if (!proxy) {
    console.log("[server] No Node fetch proxy env detected")
    return false
  }
  const configuredKeys = presentProxyEnvKeys(env)
  const normalized = normalizeProxyConfig(proxy)
  if (!normalized.proxy) {
    console.warn("[server] Skipped Node fetch proxy env with unsupported protocol", {
      keys: configuredKeys,
      skipped: normalized.skipped,
    })
    return false
  }
  try {
    const { EnvHttpProxyAgent, setGlobalDispatcher } = await load()
    setGlobalDispatcher(new EnvHttpProxyAgent(normalized.proxy))
    console.log("[server] Configured Node fetch proxy from env", {
      keys: configuredKeys,
    })
    return true
  } catch (error) {
    console.warn("[server] Failed to configure Node fetch proxy from env", {
      keys: configuredKeys,
      skipped: normalized.skipped,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

export const buildServerEnvForTest = buildServerEnv
export const githubConfigDirForTest = githubConfigDir
export const proxyConfigFromEnvForTest = proxyConfigFromEnv
export const configureProxyDispatcherForTest = configureProxyDispatcher

export async function checkHealth(url: string, password?: string | null): Promise<boolean> {
  let healthUrl: URL
  try {
    healthUrl = new URL("/global/health", url)
  } catch {
    return false
  }

  const headers = new Headers()
  if (password) {
    const auth = Buffer.from(`${PAWWORK_RUNTIME.serverUsername}:${password}`).toString("base64")
    headers.set("authorization", `Basic ${auth}`)
  }

  try {
    const res = await fetch(healthUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}
