import { app } from "electron"
import { DEFAULT_SERVER_URL_KEY, WSL_ENABLED_KEY } from "./constants"
import { rendererOrigin } from "./renderer-protocol"
import { PAWWORK_RUNTIME, runtimeRoots } from "./runtime-namespace"
import { getUserShell, loadShellEnv } from "./shell-env"
import { getStore } from "./store"

export type WslConfig = { enabled: boolean }

export type HealthCheck = { wait: Promise<void> }

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

function buildServerEnv(password: string) {
  const shell = process.platform === "win32" ? null : getUserShell()
  const shellEnv = shell ? (loadShellEnv(shell) ?? {}) : {}
  const roots = runtimeRoots(app.getPath("userData"))
  return {
    ...process.env,
    ...shellEnv,
    OPENCODE_EXPERIMENTAL_ICON_DISCOVERY: "true",
    OPENCODE_EXPERIMENTAL_FILEWATCHER: "true",
    OPENCODE_CLIENT: PAWWORK_RUNTIME.client,
    OPENCODE_SERVER_USERNAME: PAWWORK_RUNTIME.serverUsername,
    OPENCODE_SERVER_PASSWORD: password,
    PAWWORK_RUNTIME_NAMESPACE: "pawwork",
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

export const buildServerEnvForTest = buildServerEnv

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
