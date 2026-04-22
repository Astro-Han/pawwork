import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import path from "node:path"

const userData = "/tmp/pawwork-user-data"
const serverRoots = {
  data: path.join(userData, "data"),
  cache: path.join(userData, "cache"),
  config: path.join(userData, "config"),
  state: path.join(userData, "state"),
}

mock.module("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" ? userData : `/tmp/${name}`),
    isPackaged: false,
  },
}))

mock.module("./store", () => ({
  store: {
    get: () => null,
    set: () => undefined,
    delete: () => undefined,
  },
}))

mock.module("./shell-env", () => ({
  getUserShell: () => null,
  isNushell: (shell: string) => {
    const name = path.basename(shell).toLowerCase()
    const raw = shell.toLowerCase()
    return name === "nu" || name === "nu.exe" || raw.endsWith("\\nu.exe")
  },
  loadShellEnv: () => ({}),
  mergeShellEnv: (shell: Record<string, string> | null, env: Record<string, string>) => ({
    ...(shell || {}),
    ...env,
  }),
  parseShellEnv: (out: Buffer) => {
    const env: Record<string, string> = {}
    for (const line of out.toString("utf8").split("\0")) {
      if (!line) continue
      const ix = line.indexOf("=")
      if (ix <= 0) continue
      env[line.slice(0, ix)] = line.slice(ix + 1)
    }
    return env
  },
}))

const originalEnv = { ...process.env }

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key]
  }
  Object.assign(process.env, originalEnv)
})

afterAll(() => {
  mock.restore()
})

describe("desktop server runtime namespace", () => {
  test("prepares PawWork-owned server environment before embedded server import", async () => {
    const { buildServerEnvForTest } = await import("./server")

    const env = buildServerEnvForTest("secret")

    expect(env.OPENCODE_CLIENT).toBe("desktop")
    expect(env.OPENCODE_SERVER_USERNAME).toBe("PawWork")
    expect(env.OPENCODE_SERVER_PASSWORD).toBe("secret")
    expect(env.PAWWORK_RUNTIME_NAMESPACE).toBe("pawwork")
    expect(env.XDG_DATA_HOME).toBe(serverRoots.data)
    expect(env.XDG_CACHE_HOME).toBe(serverRoots.cache)
    expect(env.XDG_CONFIG_HOME).toBe(serverRoots.config)
    expect(env.XDG_STATE_HOME).toBe(serverRoots.state)
  })

  test("runtime roots keep Windows-shaped user data under PawWork", async () => {
    const { databasePathForUserData, runtimeRoots } = await import("./runtime-namespace")
    const root = "C:\\Users\\u\\AppData\\Roaming\\ai.pawwork.desktop.dev"
    const roots = runtimeRoots(root)

    expect(roots).toEqual({
      data: path.join(root, "data"),
      cache: path.join(root, "cache"),
      config: path.join(root, "config"),
      state: path.join(root, "state"),
    })
    expect(databasePathForUserData(root)).toBe(path.join(root, "data", "pawwork", "pawwork.db"))
  })

  test("health check uses PawWork Basic Auth username", async () => {
    let authorization = ""
    const previousFetch = globalThis.fetch
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get("authorization") ?? ""
      return new Response(null, { status: 200 })
    }) as typeof fetch

    try {
      const { checkHealth } = await import("./server")
      expect(await checkHealth("http://127.0.0.1:4096", "secret")).toBeTrue()
      expect(Buffer.from(authorization.replace("Basic ", ""), "base64").toString("utf8")).toBe("PawWork:secret")
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  test("spawnLocalServer prepares env before importing the embedded server", async () => {
    let captured: Record<string, string | undefined> | undefined

    mock.module("virtual:opencode-server", () => {
      captured = {
        XDG_DATA_HOME: process.env.XDG_DATA_HOME,
        XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
        XDG_STATE_HOME: process.env.XDG_STATE_HOME,
        PAWWORK_RUNTIME_NAMESPACE: process.env.PAWWORK_RUNTIME_NAMESPACE,
        OPENCODE_CLIENT: process.env.OPENCODE_CLIENT,
        OPENCODE_SERVER_USERNAME: process.env.OPENCODE_SERVER_USERNAME,
      }
      return {
        Log: { init: async () => undefined },
        Server: {
          listen: async () => ({ stop: async () => undefined }),
        },
      }
    })

    const previousFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch

    try {
      const { spawnLocalServer } = await import("./server")
      await spawnLocalServer("127.0.0.1", 4096, "secret")
      expect(captured).toEqual({
        XDG_DATA_HOME: serverRoots.data,
        XDG_CACHE_HOME: serverRoots.cache,
        XDG_CONFIG_HOME: serverRoots.config,
        XDG_STATE_HOME: serverRoots.state,
        PAWWORK_RUNTIME_NAMESPACE: "pawwork",
        OPENCODE_CLIENT: "desktop",
        OPENCODE_SERVER_USERNAME: "PawWork",
      })
    } finally {
      globalThis.fetch = previousFetch
    }
  })
})
