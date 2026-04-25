import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import path from "node:path"
import { rendererOrigin } from "./renderer-protocol"

const userData = "/tmp/pawwork-user-data"
const serverRoots = {
  data: path.join(userData, "data"),
  cache: path.join(userData, "cache"),
  config: path.join(userData, "config"),
  state: path.join(userData, "state"),
}

let mockShellEnv: Record<string, string> = {}

mock.module("electron", () => ({
  app: {
    getPath: (name: string) => (name === "userData" ? userData : `/tmp/${name}`),
    isPackaged: false,
  },
}))

mock.module("./store", () => ({
  getStore: () => ({
    get: () => null,
    set: () => undefined,
    delete: () => undefined,
  }),
}))

mock.module("./shell-env", () => ({
  getUserShell: () => "/bin/zsh",
  isNushell: (shell: string) => {
    const name = path.basename(shell).toLowerCase()
    const raw = shell.toLowerCase()
    return name === "nu" || name === "nu.exe" || raw.endsWith("\\nu.exe")
  },
  loadShellEnv: () => mockShellEnv,
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
  mockShellEnv = {}
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key]
  }
  Object.assign(process.env, originalEnv)
})

afterAll(() => {
  mock.restore()
})

describe("desktop server runtime namespace", () => {
  const nonWindowsTest = process.platform === "win32" ? test.skip : test

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

  test("uses process GitHub CLI config directory before shell config directory", async () => {
    process.env.GH_CONFIG_DIR = "/process/gh"
    mockShellEnv = { GH_CONFIG_DIR: "/shell/gh", XDG_CONFIG_HOME: "/shell/config" }
    const { buildServerEnvForTest } = await import("./server")

    const env = buildServerEnvForTest("secret")

    expect(env.XDG_CONFIG_HOME).toBe(serverRoots.config)
    expect(env.GH_CONFIG_DIR).toBe("/process/gh")
  })

  test("keeps explicit GitHub CLI config directory while isolating PawWork config", async () => {
    process.env.GH_CONFIG_DIR = "/custom/gh"
    process.env.XDG_CONFIG_HOME = "/user/config"
    process.env.HOME = "/Users/example"
    const { buildServerEnvForTest } = await import("./server")

    const env = buildServerEnvForTest("secret")

    expect(env.XDG_CONFIG_HOME).toBe(serverRoots.config)
    expect(env.GH_CONFIG_DIR).toBe("/custom/gh")
  })

  test("keeps process env values before shell env values", async () => {
    process.env.PAWWORK_TEST_ENV = "process"
    mockShellEnv = { PAWWORK_TEST_ENV: "shell" }
    const { buildServerEnvForTest } = await import("./server")

    const env = buildServerEnvForTest("secret")

    expect(env.PAWWORK_TEST_ENV).toBe("process")
  })

  nonWindowsTest("keeps login shell PATH so Homebrew commands remain discoverable", async () => {
    process.env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin"
    mockShellEnv = {
      PATH: "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin",
    }
    const { buildServerEnvForTest } = await import("./server")

    const env = buildServerEnvForTest("secret")

    expect(env.PATH).toBe("/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin")
  })

  nonWindowsTest("keeps process GitHub CLI config priority without letting process PATH override shell PATH", async () => {
    process.env.PATH = "/usr/bin:/bin"
    process.env.GH_CONFIG_DIR = "/process/gh"
    mockShellEnv = {
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      GH_CONFIG_DIR: "/shell/gh",
      XDG_CONFIG_HOME: "/shell/config",
    }
    const { buildServerEnvForTest } = await import("./server")

    const env = buildServerEnvForTest("secret")

    expect(env.PATH).toBe("/opt/homebrew/bin:/usr/bin:/bin")
    expect(env.GH_CONFIG_DIR).toBe("/process/gh")
    expect(env.XDG_CONFIG_HOME).toBe(serverRoots.config)
  })

  nonWindowsTest("derives GitHub CLI config directory from shell XDG config home", async () => {
    delete process.env.GH_CONFIG_DIR
    delete process.env.XDG_CONFIG_HOME
    mockShellEnv = { XDG_CONFIG_HOME: "/shell/config" }
    process.env.HOME = "/Users/example"
    const { buildServerEnvForTest } = await import("./server")

    const env = buildServerEnvForTest("secret")

    expect(env.XDG_CONFIG_HOME).toBe(serverRoots.config)
    expect(env.GH_CONFIG_DIR).toBe(path.join("/shell/config", "gh"))
  })

  test("uses process XDG config home before shell XDG config home", async () => {
    delete process.env.GH_CONFIG_DIR
    process.env.XDG_CONFIG_HOME = "/process/config"
    mockShellEnv = { XDG_CONFIG_HOME: "/shell/config" }
    process.env.HOME = "/Users/example"
    const { buildServerEnvForTest } = await import("./server")

    const env = buildServerEnvForTest("secret")

    expect(env.XDG_CONFIG_HOME).toBe(serverRoots.config)
    expect(env.GH_CONFIG_DIR).toBe(path.join("/process/config", "gh"))
  })

  nonWindowsTest("derives GitHub CLI config directory from home when original XDG config home is absent", async () => {
    delete process.env.GH_CONFIG_DIR
    delete process.env.XDG_CONFIG_HOME
    mockShellEnv = {}
    process.env.HOME = "/Users/example"
    const { buildServerEnvForTest } = await import("./server")

    const env = buildServerEnvForTest("secret")

    expect(env.XDG_CONFIG_HOME).toBe(serverRoots.config)
    expect(env.GH_CONFIG_DIR).toBe(path.join("/Users/example", ".config", "gh"))
  })

  test("derives Windows GitHub CLI config directory from AppData when XDG config home is absent", async () => {
    delete process.env.GH_CONFIG_DIR
    const { githubConfigDirForTest } = await import("./server")

    expect(
      githubConfigDirForTest(
        {
          AppData: "C:\\Users\\example\\AppData\\Roaming",
          HOME: "C:\\Users\\example",
        },
        "win32",
      ),
    ).toBe(path.join("C:\\Users\\example\\AppData\\Roaming", "GitHub CLI"))
  })

  test("derives Windows GitHub CLI config directory from uppercase APPDATA", async () => {
    delete process.env.GH_CONFIG_DIR
    const { githubConfigDirForTest } = await import("./server")

    expect(
      githubConfigDirForTest(
        {
          APPDATA: "C:\\Users\\example\\AppData\\Roaming",
          HOME: "C:\\Users\\example",
        },
        "win32",
      ),
    ).toBe(path.join("C:\\Users\\example\\AppData\\Roaming", "GitHub CLI"))
  })

  test("derives Windows GitHub CLI config directory from lowercase appdata", async () => {
    delete process.env.GH_CONFIG_DIR
    const { githubConfigDirForTest } = await import("./server")

    expect(
      githubConfigDirForTest(
        {
          appdata: "C:\\Users\\example\\AppData\\Roaming",
          HOME: "C:\\Users\\example",
        },
        "win32",
      ),
    ).toBe(path.join("C:\\Users\\example\\AppData\\Roaming", "GitHub CLI"))
  })

  test("uses injectable path utility for platform-specific GitHub CLI config paths", async () => {
    delete process.env.GH_CONFIG_DIR
    const { githubConfigDirForTest } = await import("./server")
    const pathUtils = {
      join: (...parts: string[]) => parts.join("\\"),
    }

    expect(
      githubConfigDirForTest(
        {
          APPDATA: "C:\\Users\\example\\AppData\\Roaming",
        },
        "win32",
        pathUtils,
      ),
    ).toBe("C:\\Users\\example\\AppData\\Roaming\\GitHub CLI")
  })

  test("derives Windows GitHub CLI config directory from home when AppData is absent", async () => {
    delete process.env.GH_CONFIG_DIR
    const { githubConfigDirForTest } = await import("./server")

    expect(
      githubConfigDirForTest(
        {
          HOME: "C:\\Users\\example",
        },
        "win32",
      ),
    ).toBe(path.join("C:\\Users\\example", ".config", "gh"))
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
    let listenOptions: unknown

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
          listen: async (opts: unknown) => {
            listenOptions = opts
            return { stop: async () => undefined }
          },
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
      expect(listenOptions).toMatchObject({
        cors: [rendererOrigin],
      })
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  test("maps ALL_PROXY to HTTP and HTTPS proxy config", async () => {
    const { proxyConfigFromEnvForTest } = await import("./server")

    expect(
      proxyConfigFromEnvForTest({
        ALL_PROXY: "http://127.0.0.1:7897",
        NO_PROXY: "localhost,127.0.0.1",
      }),
    ).toEqual({
      httpProxy: "http://127.0.0.1:7897",
      httpsProxy: "http://127.0.0.1:7897",
      noProxy: "localhost,127.0.0.1",
    })
  })

  test("configureProxyDispatcher skips when no HTTP or HTTPS proxy env is present", async () => {
    const { configureProxyDispatcherForTest } = await import("./server")

    const configured = await configureProxyDispatcherForTest(
      {
        NO_PROXY: "localhost",
      },
      async () => {
        throw new Error("undici should not load without proxy env")
      },
    )

    expect(configured).toBe(false)
  })

  test("configureProxyDispatcher registers EnvHttpProxyAgent using env-derived proxy config", async () => {
    let capturedOptions: Record<string, string | undefined> | undefined
    let capturedDispatcher: unknown
    const { configureProxyDispatcherForTest } = await import("./server")

    const configured = await configureProxyDispatcherForTest(
      {
        HTTPS_PROXY: "http://127.0.0.1:7897",
        HTTP_PROXY: "http://127.0.0.1:7897",
        NO_PROXY: "localhost,127.0.0.1",
      },
      async () => ({
        EnvHttpProxyAgent: class {
          constructor(options: Record<string, string | undefined>) {
            capturedOptions = options
          }
        } as any,
        setGlobalDispatcher: (dispatcher: unknown) => {
          capturedDispatcher = dispatcher
        },
      }),
    )

    expect(configured).toBe(true)
    expect(capturedOptions).toEqual({
      httpProxy: "http://127.0.0.1:7897",
      httpsProxy: "http://127.0.0.1:7897",
      noProxy: "localhost,127.0.0.1",
    })
    expect(capturedDispatcher).toBeTruthy()
  })

  test("configureProxyDispatcher skips unsupported proxy protocols without crashing startup", async () => {
    const warnings: unknown[] = []
    const previousWarn = console.warn
    console.warn = (...args) => {
      warnings.push(args)
    }

    try {
      const { configureProxyDispatcherForTest } = await import("./server")
      const configured = await configureProxyDispatcherForTest(
        {
          ALL_PROXY: "socks5h://127.0.0.1:7897",
          NO_PROXY: "localhost,127.0.0.1",
        },
        () => import("undici"),
      )

      expect(configured).toBe(false)
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toEqual([
        "[server] Skipped Node fetch proxy env with unsupported protocol",
        {
          keys: ["ALL_PROXY", "NO_PROXY"],
          skipped: {
            httpProxy: true,
            httpsProxy: true,
          },
        },
      ])
    } finally {
      console.warn = previousWarn
    }
  })
})
