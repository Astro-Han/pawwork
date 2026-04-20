import { describe, expect, test } from "bun:test"
import type { Config, Path, Project, ProviderListResponse, VcsInfo } from "@opencode-ai/sdk/v2/client"
import { QueryClient } from "@tanstack/solid-query"
import { createStore } from "solid-js/store"
import { bootstrapDirectory } from "./bootstrap"
import { loadSessionsQuery } from "../global-sync"
import type { State, VcsCache } from "./types"

function createState(): State {
  return {
    status: "loading",
    agent: [],
    command: [],
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
    session_diff: {},
    todo: {},
    permission: {},
    question: {},
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

async function waitFor(check: () => boolean, timeoutMs = 300) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("timed out waiting for condition")
}

describe("bootstrapDirectory", () => {
  test("refreshes directory providers even when sessions query cache is already populated", async () => {
    const directory = "/tmp/project"
    const queryClient = new QueryClient()
    queryClient.setQueryData(loadSessionsQuery(directory).queryKey, null)

    const [store, setStore] = createStore(createState())
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

    await waitFor(() => providerCalls === 1)

    expect(store.provider_ready).toBe(true)
    expect(store.provider).toEqual(providers[0])

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
})
