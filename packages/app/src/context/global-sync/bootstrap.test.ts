import { describe, expect, mock, test } from "bun:test"
import type { Config, Path, Project, ProviderListResponse, VcsInfo } from "@opencode-ai/sdk/v2/client"
import { QueryClient } from "@tanstack/solid-query"
import { createStore } from "solid-js/store"
import {
  activeSessionStatuses,
  bootstrapDirectory,
  hydratePendingExternalResults,
  mergeSessionStatusSnapshot,
} from "./bootstrap"
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
    turn_change_aggregate: {},
    todo: {},
    permission: {},
    external_result_question: {},
    mcp_ready: false,
    mcp: {},
    lsp_ready: false,
    lsp: [],
    vcs: undefined,
    limit: 5,
    message: {},
    part: {},
    automation: {},
    automation_run: {},
    automation_tombstone: {},
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

  test("tolerates undefined pending question slots while pruning stale questions", async () => {
    const directory = "/repo"
    const queryClient = new QueryClient()
    const [store, setStore] = createStore(createState())
    setStore("external_result_question", "ses_undefined", undefined as never)
    setStore("external_result_question", "ses_stale", [
      {
        id: "msg_stale:call_stale",
        sessionID: "ses_stale",
        questions: [{ question: "Continue?" }],
        messageID: "msg_stale",
        callID: "call_stale",
        partID: "part_stale",
      },
    ])
    let externalResultCalls = 0
    const warnings: unknown[] = []
    const originalWarn = console.warn
    console.warn = mock((...args: unknown[]) => {
      warnings.push(args)
    }) as typeof console.warn
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
      externalResult: {
        list: async () => {
          externalResultCalls += 1
          return { data: [] }
        },
      },
      mcp: { status: async () => ({ data: {} }) },
      automation: { list: async () => ({ data: { items: [] } }) },
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
      await waitFor(() => externalResultCalls === 1)
      await waitFor(() => store.external_result_question.ses_stale === undefined)
      expect(warnings).toEqual([])
    } finally {
      console.warn = originalWarn
    }
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
      externalResult: { list: async () => ({ data: [] }) },
      mcp: { status: async () => ({ data: {} }) },
      automation: { list: async () => ({ data: { items: [] } }) },
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
      externalResult: { list: async () => ({ data: [] }) },
      mcp: { status: async () => ({ data: {} }) },
      automation: { list: async () => ({ data: { items: [] } }) },
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

      await waitFor(() => store.session_status_state === "error")

      expect(store.session_status_state).toBe("error")
      expect(store.session_status_ready).toBe(false)
      expect(store.session_status).toEqual({ ses_busy: { type: "busy" } })
    } finally {
      console.error = originalError
    }
  })

  test("skips pending interaction entries when warm session lookup returns 404", async () => {
    const directory = "/tmp/project"
    const queryClient = new QueryClient()
    const [store, setStore] = createStore(createState())
    setStore("permission", "ses_missing", [
      {
        id: "perm_old",
        sessionID: "ses_missing",
        permission: "edit",
        patterns: ["/tmp/old.txt"],
        metadata: {},
        always: ["/tmp/old.txt"],
      } as any,
    ])

    const notFound = { name: "NotFoundError", response: { status: 404 } }
    const validSession = {
      id: "ses_valid",
      title: "Valid session",
      directory,
      version: "test",
      time: { created: 1, updated: 1 },
    }
    const sdk = {
      app: { agents: async () => ({ data: [] }) },
      config: { get: async () => ({ data: {} as Config }) },
      session: {
        status: async () => ({ data: {} }),
        get: async ({ sessionID }: { sessionID: string }) => {
          if (sessionID === "ses_missing") throw notFound
          return { data: validSession }
        },
      },
      project: { current: async () => ({ data: { id: "project-1" } }) },
      path: { get: async () => ({ data: { state: "", config: "", worktree: "", directory, home: "" } as Path }) },
      vcs: { get: async () => ({ data: undefined }) },
      command: { list: async () => ({ data: [] }) },
      permission: {
        list: async () => ({
          data: [
            {
              id: "perm_missing",
              sessionID: "ses_missing",
              permission: "edit",
              patterns: ["/tmp/missing.txt"],
              metadata: {},
              always: ["/tmp/missing.txt"],
            },
            {
              id: "perm_valid",
              sessionID: "ses_valid",
              permission: "edit",
              patterns: ["/tmp/valid.txt"],
              metadata: {},
              always: ["/tmp/valid.txt"],
            },
          ],
        }),
      },
      externalResult: { list: async () => ({ data: [] }) },
      mcp: { status: async () => ({ data: {} }) },
      automation: { list: async () => ({ data: { items: [] } }) },
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

    await waitFor(() => store.session.some((session) => session.id === "ses_valid"))
    await waitFor(() => store.permission.ses_valid?.length === 1)

    expect(store.permission.ses_missing ?? []).toEqual([])
    expect(store.permission.ses_valid?.map((entry) => entry.id)).toEqual(["perm_valid"])
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
      externalResult: { list: async () => ({ data: [] }) },
      mcp: { status: async () => ({ data: {} }) },
      automation: { list: async () => ({ data: { items: [] } }) },
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
      externalResult: { list: async () => ({ data: [] }) },
      mcp: { status: async () => ({ data: {} }) },
      automation: { list: async () => ({ data: { items: [] } }) },
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
      externalResult: { list: async () => ({ data: [] }) },
      mcp: { status: async () => ({ data: {} }) },
      automation: { list: async () => ({ data: { items: [] } }) },
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
      externalResult: { list: async () => ({ data: [] }) },
      mcp: { status: async () => ({ data: {} }) },
      automation: { list: async () => ({ data: { items: [] } }) },
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
      externalResult: { list: async () => ({ data: [] }) },
      mcp: { status: async () => ({ data: {} }) },
      automation: { list: async () => ({ data: { items: [] } }) },
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

describe("hydratePendingExternalResults", () => {
  const directory = "/tmp/project"
  const parentSession = {
    id: "ses_parent",
    title: "Parent",
    directory,
    version: "test",
    time: { created: 1, updated: 1 },
  } as any
  const childSession = {
    id: "ses_child",
    parentID: "ses_parent",
    title: "Child agent",
    directory,
    version: "test",
    time: { created: 2, updated: 2 },
  } as any
  const childMessage = {
    id: "msg_child",
    sessionID: "ses_child",
    role: "assistant",
    time: { created: 3 },
  } as any
  const childPart = {
    id: "part_child",
    type: "tool",
    tool: "question",
    callID: "call_child",
    messageID: "msg_child",
    sessionID: "ses_child",
    state: {
      status: "running",
      input: { questions: [{ header: "h", question: "q?", options: [] }] },
      title: "",
      metadata: { externalResultReady: true },
      time: { start: 0 },
    },
  } as any

  test("writes session, message, and part entries for a child agent's pending question", () => {
    const [store, setStore] = createStore(createState())
    hydratePendingExternalResults({
      store,
      setStore,
      entries: [{ session: childSession, message: childMessage, part: childPart }],
    })
    expect(store.session.map((s) => s.id)).toEqual(["ses_child"])
    expect(store.message.ses_child?.map((m) => m.id)).toEqual(["msg_child"])
    expect(store.part.msg_child?.map((p) => p.id)).toEqual(["part_child"])
    expect(store.external_result_question.ses_child?.[0]).toMatchObject({
      id: "msg_child:call_child",
      sessionID: "ses_child",
      messageID: "msg_child",
      callID: "call_child",
      partID: "part_child",
    })
  })

  test("prunes indexed pending questions that are absent from the pending hydrate snapshot", () => {
    const [store, setStore] = createStore(createState())
    setStore("external_result_question", "ses_child", [
      {
        id: "msg_child:call_child",
        sessionID: "ses_child",
        questions: [{ header: "h", question: "q?", options: [] }],
        messageID: "msg_child",
        callID: "call_child",
        partID: "part_child",
      },
    ])
    hydratePendingExternalResults({
      store,
      setStore,
      entries: [],
      pruneQuestionIDs: new Set(["msg_child:call_child"]),
    })
    expect(store.external_result_question.ses_child).toBeUndefined()
  })

  test("removes pruned ready question parts so fallback traversal cannot reopen the dock", () => {
    const [store, setStore] = createStore(createState())
    setStore("message", "ses_child", [childMessage])
    setStore("part", "msg_child", [childPart])
    setStore("external_result_question", "ses_child", [
      {
        id: "msg_child:call_child",
        sessionID: "ses_child",
        questions: [{ header: "h", question: "q?", options: [] }],
        messageID: "msg_child",
        callID: "call_child",
        partID: "part_child",
      },
    ])
    hydratePendingExternalResults({
      store,
      setStore,
      entries: [],
      pruneQuestionIDs: new Set(["msg_child:call_child"]),
    })
    expect(store.external_result_question.ses_child).toBeUndefined()
    expect(store.part.msg_child).toBeUndefined()
  })

  test("does not prune questions added after the pending hydrate request snapshot", () => {
    const [store, setStore] = createStore(createState())
    setStore("external_result_question", "ses_child", [
      {
        id: "msg_old:call_old",
        sessionID: "ses_child",
        questions: [{ header: "h", question: "old?", options: [] }],
        messageID: "msg_old",
        callID: "call_old",
        partID: "part_old",
      },
      {
        id: "msg_new:call_new",
        sessionID: "ses_child",
        questions: [{ header: "h", question: "new?", options: [] }],
        messageID: "msg_new",
        callID: "call_new",
        partID: "part_new",
      },
    ])
    hydratePendingExternalResults({
      store,
      setStore,
      entries: [],
      pruneQuestionIDs: new Set(["msg_old:call_old"]),
    })
    expect(store.external_result_question.ses_child?.map((question) => question.id)).toEqual(["msg_new:call_new"])
  })

  test("merges into existing session list and existing message list without duplicating", () => {
    const [store, setStore] = createStore(createState())
    setStore("session", [parentSession])
    setStore("message", "ses_child", [{ id: "msg_existing" } as any])
    hydratePendingExternalResults({
      store,
      setStore,
      entries: [{ session: childSession, message: childMessage, part: childPart }],
    })
    expect(store.session.map((s) => s.id)).toEqual(["ses_child", "ses_parent"])
    expect(store.message.ses_child?.map((m) => m.id).sort()).toEqual(["msg_child", "msg_existing"])
    expect(store.part.msg_child?.map((p) => p.id)).toEqual(["part_child"])
  })

  test("replaces an existing part with the same id (reconcile path)", () => {
    const [store, setStore] = createStore(createState())
    const stalePart = {
      ...childPart,
      state: { ...childPart.state, metadata: { externalResultReady: false } },
    }
    setStore("session", [childSession])
    setStore("message", "ses_child", [childMessage])
    setStore("part", "msg_child", [stalePart])
    hydratePendingExternalResults({
      store,
      setStore,
      entries: [{ session: childSession, message: childMessage, part: childPart }],
    })
    expect(store.part.msg_child?.length).toBe(1)
    const updated = store.part.msg_child?.[0] as any
    expect(updated?.state?.metadata?.externalResultReady).toBe(true)
  })

  test("does not let a stale pending hydrate response revert a local terminal question part", () => {
    const [store, setStore] = createStore(createState())
    const terminalPart = {
      ...childPart,
      state: { ...childPart.state, status: "completed" },
    } as any
    setStore("part", "msg_child", [terminalPart])
    hydratePendingExternalResults({
      store,
      setStore,
      entries: [{ session: childSession, message: childMessage, part: childPart }],
      pruneQuestionIDs: new Set(["msg_child:call_child"]),
    })
    expect(store.session.map((s) => s.id)).toEqual(["ses_child"])
    expect(store.message.ses_child?.map((m) => m.id)).toEqual(["msg_child"])
    expect(store.external_result_question.ses_child).toBeUndefined()
    const updated = store.part.msg_child?.[0] as any
    expect(updated?.state?.status).toBe("completed")
  })

  test("skips entries that are missing identifiers", () => {
    const [store, setStore] = createStore(createState())
    hydratePendingExternalResults({
      store,
      setStore,
      entries: [
        { session: { id: "" } as any, message: childMessage, part: childPart },
        { session: childSession, message: { ...childMessage, id: "" } as any, part: childPart },
        { session: childSession, message: childMessage, part: { ...childPart, id: "" } as any },
      ],
    })
    expect(store.session.length).toBe(0)
    expect(store.message).toEqual({})
    expect(store.part).toEqual({})
  })
})
