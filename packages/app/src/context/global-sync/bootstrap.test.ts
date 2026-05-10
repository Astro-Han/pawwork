import { describe, expect, mock, test } from "bun:test"
import type { Config, Path, Project, ProviderListResponse, VcsInfo } from "@opencode-ai/sdk/v2/client"
import { QueryClient } from "@tanstack/solid-query"
import { createStore } from "solid-js/store"
import { activeSessionStatuses, bootstrapDirectory, mergeSessionStatusSnapshot } from "./bootstrap"
import { loadSessionsQuery } from "../global-sync"
import type { State, VcsCache } from "./types"

function createState(): State {
  return {
    status: "loading",
    agent: [],
    command: [],
    command_ready: false,
    project: "",
    projectMeta: undefined,
    icon: undefined,
    provider_ready: false,
    provider: { all: [], connected: [], default: {} },
    config: {},
    path: { state: "", config: "", worktree: "", directory: "", home: "" },
    session: [],
    sessionTotal: 0,
    session_status: {},
    session_status_state: "loading",
    session_status_ready: false,
    session_diff: {},
    todo: {},
    permission: {},
    question: {},
    blocker: {},
    mcp_ready: false,
    mcp: {},
    lsp_ready: false,
    lsp: [],
    vcs: undefined,
    limit: 5,
    message: {},
    part: {},
  }
}

function createVcsCache(): VcsCache {
  const [store, setStore] = createStore({ value: undefined as VcsInfo | undefined })
  return {
    store,
    setStore,
    ready: () => true,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

async function waitFor(check: () => boolean, timeoutMs = 300) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("timed out waiting for condition")
}

describe("bootstrapDirectory", () => {
  test("keeps only active statuses while resetting status hydration", () => {
    expect(
      activeSessionStatuses({
        idle: { type: "idle" },
        busy: { type: "busy" },
        retry: { type: "retry", attempt: 1, message: "retrying", next: 1 },
      }),
    ).toEqual({
      busy: { type: "busy" },
      retry: { type: "retry", attempt: 1, message: "retrying", next: 1 },
    })
  })

  test("status snapshot clears stale active statuses from before the request", () => {
    expect(
      mergeSessionStatusSnapshot({
        baseline: { ses_1: { type: "busy" } },
        current: { ses_1: { type: "busy" } },
        snapshot: { ses_1: { type: "idle" } },
      }),
    ).toEqual({ ses_1: { type: "idle" } })
  })

  test("status snapshot keeps active status events that arrive during the request", () => {
    expect(
      mergeSessionStatusSnapshot({
        baseline: { stale: { type: "busy" } },
        current: {
          stale: { type: "busy" },
          fresh: { type: "busy" },
        },
        snapshot: {
          stale: { type: "idle" },
          fresh: { type: "idle" },
        },
      }),
    ).toEqual({
      stale: { type: "idle" },
      fresh: { type: "busy" },
    })
  })

  test("refreshes directory providers even when sessions query cache is already populated", async () => {
    const directory = "/tmp/project"
    const queryClient = new QueryClient()
    queryClient.setQueryData(loadSessionsQuery(directory).queryKey, null)

    const [store, setStore] = createStore(createState())
    setStore("session_status", "ses_stale", { type: "idle" })
    const providers = [
      {
        all: [{ id: "dir-provider-a", name: "Dir Provider A", source: "custom", env: [], options: {}, models: {} }],
        connected: ["dir-provider-a"],
        default: {},
      },
      {
        all: [{ id: "dir-provider-b", name: "Dir Provider B", source: "custom", env: [], options: {}, models: {} }],
        connected: ["dir-provider-b"],
        default: {},
      },
    ] satisfies ProviderListResponse[]

    let providerCalls = 0

    const sdk = {
      app: { agents: async () => ({ data: [] }) },
      config: { get: async () => ({ data: {} as Config }) },
      session: {
        status: async () => ({ data: {} }),
        get: async () => ({ data: undefined }),
      },
      project: { current: async () => ({ data: { id: "project-1" } }) },
      path: { get: async () => ({ data: { state: "", config: "", worktree: "", directory, home: "" } as Path }) },
      vcs: { get: async () => ({ data: undefined }) },
      command: { list: async () => ({ data: [] }) },
      permission: { list: async () => ({ data: [] }) },
      question: { list: async () => ({ data: [] }) },
      blocker: { list: async () => ({ data: [] }) },
      mcp: { status: async () => ({ data: {} }) },
      provider: {
        list: async () => {
          const next = providers[Math.min(providerCalls, providers.length - 1)]
          providerCalls += 1
          return { data: next }
        },
      },
    } as any

    await bootstrapDirectory({
      directory,
      sdk,
      store,
      setStore,
      vcsCache: createVcsCache(),
      loadSessions: () => undefined,
      translate: (key) => key,
      global: {
        config: {} as Config,
        path: { state: "", config: "", worktree: "", directory: "", home: "" } as Path,
        project: [] as Project[],
        provider: { all: [], connected: [], default: {} },
      },
      queryClient,
    })

    expect(store.session_status).toEqual({})
    await waitFor(() => providerCalls === 1)
    await waitFor(() => store.session_status_state === "ready")

    expect(store.provider_ready).toBe(true)
    expect(store.provider).toEqual(providers[0])
    expect(store.session_status_state).toBe("ready")
    expect(store.session_status_ready).toBe(true)

    await bootstrapDirectory({
      directory,
      sdk,
      store,
      setStore,
      vcsCache: createVcsCache(),
      loadSessions: () => undefined,
      translate: (key) => key,
      global: {
        config: {} as Config,
        path: { state: "", config: "", worktree: "", directory: "", home: "" } as Path,
        project: [] as Project[],
        provider: { all: [], connected: [], default: {} },
      },
      queryClient,
    })

    await waitFor(() => providerCalls === 2)

    expect(providerCalls).toBe(2)
    expect(store.provider_ready).toBe(true)
    expect(store.provider).toEqual(providers[1])
  })

  test("marks session status as error when status hydration fails", async () => {
    const originalError = console.error
    console.error = mock(() => undefined) as typeof console.error
    const directory = "/tmp/project"
    const queryClient = new QueryClient()
    const [store, setStore] = createStore(createState())
    setStore("session_status", "ses_busy", { type: "busy" })
    setStore("session_status", "ses_idle", { type: "idle" })

    const sdk = {
      app: { agents: async () => ({ data: [] }) },
      config: { get: async () => ({ data: {} as Config }) },
      session: {
        status: async () => {
          throw new Error("status failed")
        },
        get: async () => ({ data: undefined }),
      },
      project: { current: async () => ({ data: { id: "project-1" } }) },
      path: { get: async () => ({ data: { state: "", config: "", worktree: "", directory, home: "" } as Path }) },
      vcs: { get: async () => ({ data: undefined }) },
      command: { list: async () => ({ data: [] }) },
      permission: { list: async () => ({ data: [] }) },
      question: { list: async () => ({ data: [] }) },
      blocker: { list: async () => ({ data: [] }) },
      mcp: { status: async () => ({ data: {} }) },
      provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
    } as any

    try {
      await bootstrapDirectory({
        directory,
        sdk,
        store,
        setStore,
        vcsCache: createVcsCache(),
        loadSessions: () => undefined,
        translate: (key) => key,
        global: {
          config: {} as Config,
          path: { state: "", config: "", worktree: "", directory: "", home: "" } as Path,
          project: [] as Project[],
          provider: { all: [], connected: [], default: {} },
        },
        queryClient,
      })

      await waitFor(() => store.provider_ready)

      expect(store.session_status_state).toBe("error")
      expect(store.session_status_ready).toBe(false)
      expect(store.session_status).toEqual({ ses_busy: { type: "busy" } })
    } finally {
      console.error = originalError
    }
  })

  test("keeps active status events that arrive before the status snapshot resolves", async () => {
    const directory = "/tmp/project"
    const queryClient = new QueryClient()
    const [store, setStore] = createStore(createState())
    const status = deferred<{ data: State["session_status"] }>()
    let statusStarted = false

    const sdk = {
      app: { agents: async () => ({ data: [] }) },
      config: { get: async () => ({ data: {} as Config }) },
      session: {
        status: async () => {
          statusStarted = true
          return status.promise
        },
        get: async () => ({ data: undefined }),
      },
      project: { current: async () => ({ data: { id: "project-1" } }) },
      path: { get: async () => ({ data: { state: "", config: "", worktree: "", directory, home: "" } as Path }) },
      vcs: { get: async () => ({ data: undefined }) },
      command: { list: async () => ({ data: [] }) },
      permission: { list: async () => ({ data: [] }) },
      question: { list: async () => ({ data: [] }) },
      blocker: { list: async () => ({ data: [] }) },
      mcp: { status: async () => ({ data: {} }) },
      provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
    } as any

    await bootstrapDirectory({
      directory,
      sdk,
      store,
      setStore,
      vcsCache: createVcsCache(),
      loadSessions: () => undefined,
      translate: (key) => key,
      global: {
        config: {} as Config,
        path: { state: "", config: "", worktree: "", directory: "", home: "" } as Path,
        project: [] as Project[],
        provider: { all: [], connected: [], default: {} },
      },
      queryClient,
    })

    await waitFor(() => statusStarted)
    setStore("session_status", "ses_1", { type: "busy" })

    status.resolve({ data: { ses_1: { type: "idle" } } })
    await waitFor(() => store.session_status_state === "ready")

    expect(store.session_status.ses_1).toEqual({ type: "busy" })
    expect(store.session_status_ready).toBe(true)
  })

  test("refreshes providers before unrelated slow bootstrap work finishes", async () => {
    const directory = "/tmp/project"
    const queryClient = new QueryClient()
    const [store, setStore] = createStore(createState())
    const permission = deferred<{ data: [] }>()
    const providers = {
      all: [{ id: "dir-provider", name: "Dir Provider", source: "custom", env: [], options: {}, models: {} }],
      connected: ["dir-provider"],
      default: {},
    } satisfies ProviderListResponse

    const sdk = {
      app: { agents: async () => ({ data: [] }) },
      config: { get: async () => ({ data: {} as Config }) },
      session: {
        status: async () => ({ data: {} }),
        get: async () => ({ data: undefined }),
      },
      project: { current: async () => ({ data: { id: "project-1" } }) },
      path: { get: async () => ({ data: { state: "", config: "", worktree: "", directory, home: "" } as Path }) },
      vcs: { get: async () => ({ data: undefined }) },
      command: { list: async () => ({ data: [] }) },
      permission: { list: async () => permission.promise },
      question: { list: async () => ({ data: [] }) },
      blocker: { list: async () => ({ data: [] }) },
      mcp: { status: async () => ({ data: {} }) },
      provider: { list: async () => ({ data: providers }) },
    } as any

    await bootstrapDirectory({
      directory,
      sdk,
      store,
      setStore,
      vcsCache: createVcsCache(),
      loadSessions: () => undefined,
      translate: (key) => key,
      global: {
        config: {} as Config,
        path: { state: "", config: "", worktree: "", directory: "", home: "" } as Path,
        project: [] as Project[],
        provider: { all: [], connected: [], default: {} },
      },
      queryClient,
    })

    await waitFor(() => store.provider_ready)
    expect(store.provider).toEqual(providers)

    permission.resolve({ data: [] })
  })

  test("resets command readiness until command list hydrates", async () => {
    const directory = "/tmp/project"
    const queryClient = new QueryClient()
    const [store, setStore] = createStore(createState())
    setStore("command_ready", true)
    const command = deferred<{ data: State["command"] }>()
    let commandStarted = false

    const sdk = {
      app: { agents: async () => ({ data: [] }) },
      config: { get: async () => ({ data: {} as Config }) },
      session: {
        status: async () => ({ data: {} }),
        get: async () => ({ data: undefined }),
      },
      project: { current: async () => ({ data: { id: "project-1" } }) },
      path: { get: async () => ({ data: { state: "", config: "", worktree: "", directory, home: "" } as Path }) },
      vcs: { get: async () => ({ data: undefined }) },
      command: {
        list: async () => {
          commandStarted = true
          return command.promise
        },
      },
      permission: { list: async () => ({ data: [] }) },
      question: { list: async () => ({ data: [] }) },
      blocker: { list: async () => ({ data: [] }) },
      mcp: { status: async () => ({ data: {} }) },
      provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
    } as any

    await bootstrapDirectory({
      directory,
      sdk,
      store,
      setStore,
      vcsCache: createVcsCache(),
      loadSessions: () => undefined,
      translate: (key) => key,
      global: {
        config: {} as Config,
        path: { state: "", config: "", worktree: "", directory: "", home: "" } as Path,
        project: [] as Project[],
        provider: { all: [], connected: [], default: {} },
      },
      queryClient,
    })

    await waitFor(() => commandStarted)
    expect(store.command_ready).toBe(false)

    const commands = [{ name: "release" }] as State["command"]
    command.resolve({ data: commands })
    await waitFor(() => store.command_ready)

    expect(store.command).toEqual(commands)
  })

  test("keeps command readiness false and clears commands when command list fails", async () => {
    const directory = "/tmp/project"
    const queryClient = new QueryClient()
    const [store, setStore] = createStore(createState())
    setStore("command", [{ name: "stale" }] as State["command"])
    setStore("command_ready", true)
    const command = deferred<{ data: State["command"] }>()
    let commandStarted = false

    const sdk = {
      app: { agents: async () => ({ data: [] }) },
      config: { get: async () => ({ data: {} as Config }) },
      session: {
        status: async () => ({ data: {} }),
        get: async () => ({ data: undefined }),
      },
      project: { current: async () => ({ data: { id: "project-1" } }) },
      path: { get: async () => ({ data: { state: "", config: "", worktree: "", directory, home: "" } as Path }) },
      vcs: { get: async () => ({ data: undefined }) },
      command: {
        list: async () => {
          commandStarted = true
          return command.promise
        },
      },
      permission: { list: async () => ({ data: [] }) },
      question: { list: async () => ({ data: [] }) },
      blocker: { list: async () => ({ data: [] }) },
      mcp: { status: async () => ({ data: {} }) },
      provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
    } as any

    await bootstrapDirectory({
      directory,
      sdk,
      store,
      setStore,
      vcsCache: createVcsCache(),
      loadSessions: () => undefined,
      translate: (key) => key,
      global: {
        config: {} as Config,
        path: { state: "", config: "", worktree: "", directory: "", home: "" } as Path,
        project: [] as Project[],
        provider: { all: [], connected: [], default: {} },
      },
      queryClient,
    })

    await waitFor(() => commandStarted)
    expect(store.command_ready).toBe(false)

    const originalError = console.error
    console.error = () => undefined
    try {
      command.reject(new Error("command list failed"))
      await waitFor(() => store.command.length === 0)
    } finally {
      console.error = originalError
    }

    expect(store.command_ready).toBe(false)
    expect(store.command).toEqual([])
  })

  test("latest provider refresh writes store when an older refresh resolves later", async () => {
    const directory = "/tmp/project"
    const queryClient = new QueryClient()
    const [store, setStore] = createStore(createState())
    const first = deferred<{ data: ProviderListResponse }>()
    let calls = 0
    const oldProviders = {
      all: [{ id: "old-provider", name: "Old Provider", source: "custom", env: [], options: {}, models: {} }],
      connected: ["old-provider"],
      default: {},
    } satisfies ProviderListResponse
    const newProviders = {
      all: [{ id: "new-provider", name: "New Provider", source: "custom", env: [], options: {}, models: {} }],
      connected: ["new-provider"],
      default: {},
    } satisfies ProviderListResponse

    const sdk = {
      app: { agents: async () => ({ data: [] }) },
      config: { get: async () => ({ data: {} as Config }) },
      session: {
        status: async () => ({ data: {} }),
        get: async () => ({ data: undefined }),
      },
      project: { current: async () => ({ data: { id: "project-1" } }) },
      path: { get: async () => ({ data: { state: "", config: "", worktree: "", directory, home: "" } as Path }) },
      vcs: { get: async () => ({ data: undefined }) },
      command: { list: async () => ({ data: [] }) },
      permission: { list: async () => ({ data: [] }) },
      question: { list: async () => ({ data: [] }) },
      blocker: { list: async () => ({ data: [] }) },
      mcp: { status: async () => ({ data: {} }) },
      provider: {
        list: async () => {
          calls += 1
          if (calls === 1) return first.promise
          return { data: newProviders }
        },
      },
    } as any

    const input = {
      directory,
      sdk,
      store,
      setStore,
      vcsCache: createVcsCache(),
      loadSessions: () => undefined,
      translate: (key: string) => key,
      global: {
        config: {} as Config,
        path: { state: "", config: "", worktree: "", directory: "", home: "" } as Path,
        project: [] as Project[],
        provider: { all: [], connected: [], default: {} },
      },
      queryClient,
    }

    await bootstrapDirectory(input)
    await waitFor(() => calls === 1)
    await bootstrapDirectory(input)
    await waitFor(() => store.provider.all[0]?.id === "new-provider")

    first.resolve({ data: oldProviders })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(store.provider).toEqual(newProviders)
    expect(store.provider_ready).toBe(true)
  })
})
