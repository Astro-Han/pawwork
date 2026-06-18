import type {
  AutomationCreateInput,
  AutomationUpdateInput,
  Config,
  OpencodeClient,
  Path,
  Project,
  ProviderAuthResponse,
  ProviderListResponse,
  Todo,
  TodoSnapshot,
} from "@opencode-ai/sdk/v2/client"
import { showToast } from "@opencode-ai/ui/toast"
import { getFilename } from "@opencode-ai/util/path"
import { createContext, getOwner, onCleanup, onMount, type ParentProps, untrack, useContext } from "solid-js"
import { createStore, produce, reconcile, type SetStoreFunction } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { Persist, persisted } from "@/utils/persist"
import { clientActionHeaders } from "@/utils/server"
import type { InitError } from "../pages/error"
import { useGlobalSDK } from "./global-sdk"
import { bootstrapDirectory, bootstrapGlobal, clearProviderRev } from "./global-sync/bootstrap"
import { createBlockerTerminalCache } from "./global-sync/blocker-terminal-cache"
import { createChildStoreManager } from "./global-sync/child-store"
import {
  applyDetachedDirectoryEvent,
  applyDirectoryEvent,
  applyGlobalEvent,
  cleanupDroppedSessionCaches,
} from "./global-sync/event-reducer"
import { directoryEventTargets } from "./global-sync/event-routing"
import { createRefreshQueue } from "./global-sync/queue"
import { clearSessionPrefetchDirectory } from "./global-sync/session-prefetch"
import { estimateRootSessionTotal, loadRootSessionsWithFallback } from "./global-sync/session-load"
import { trimSessions } from "./global-sync/session-trim"
import { createPendingQuestionController } from "./global-sync/pending-question-controller"
import { pendingSessionIDsForDirectory, type PendingQuestionIndex } from "./global-sync/pending-question-index"
import {
  applyAutomationDefinition,
  applyAutomationMoveResult,
  applyAutomationRun,
  applyAutomationTombstone,
  mergeAutomationRuns,
} from "./global-sync/automation-store"
import type { ProjectMeta } from "./global-sync/types"
import { SESSION_RECENT_LIMIT } from "./global-sync/types"
import { createTodoHydrateCoordinator } from "./global-sync/todo-hydrate-coordinator"
import { sanitizeProject } from "./global-sync/utils"
import { formatServerError } from "@/utils/server-errors"
import { queryOptions, useQueryClient } from "@tanstack/solid-query"

export type SessionTodoSnapshot = TodoSnapshot

export function canAcceptSessionTodo(
  current: SessionTodoSnapshot | undefined,
  incoming: SessionTodoSnapshot,
): boolean {
  return current === undefined || incoming.revision > current.revision
}

export function setSessionTodoSnapshot(
  setStore: SetStoreFunction<GlobalStore>,
  sessionID: string,
  current: SessionTodoSnapshot | undefined,
  incoming: SessionTodoSnapshot,
) {
  if (current === undefined) {
    setStore("session_todo", sessionID, incoming)
    return
  }

  setStore("session_todo", sessionID, "todos", reconcile(incoming.todos, { key: "id" }))
  setStore("session_todo", sessionID, "revision", incoming.revision)
}

export type GlobalStore = {
  ready: boolean
  error?: InitError
  path: Path
  project: Project[]
  session_todo: {
    [sessionID: string]: SessionTodoSnapshot
  }
  // The single live index of question tool calls awaiting the user, across every
  // directory the global event stream touches. Non-persisted (a condition, not a
  // log); the dock/sidebar render from parts, this feeds the Dock badge,
  // session-trim preserve, and the rising-edge alert.
  pendingQuestions: PendingQuestionIndex
  provider: ProviderListResponse
  provider_auth: ProviderAuthResponse
  config: Config
  reload: undefined | "pending" | "complete"
}

const inactiveQueryFn = async () => null

export const loadSessionsQuery = (directory: string) =>
  queryOptions<null>({ queryKey: [directory, "loadSessions"], queryFn: inactiveQueryFn, enabled: false })

function createGlobalSync() {
  const globalSDK = useGlobalSDK()
  const language = useLanguage()
  const owner = getOwner()
  if (!owner) throw new Error("GlobalSync must be created within owner")

  const sdkCache = new Map<string, OpencodeClient>()
  const booting = new Map<string, Promise<void>>()
  const sessionLoads = new Map<string, Promise<void>>()
  const sessionMeta = new Map<string, { limit: number }>()
  const blockerTerminals = createBlockerTerminalCache()
  const todoHydrate = createTodoHydrateCoordinator()

  const [projectCache, setProjectCache, projectInit] = persisted(
    Persist.global("globalSync.project", ["globalSync.project.v1"]),
    createStore({ value: [] as Project[] }),
  )

  const [globalStore, setGlobalStore] = createStore<GlobalStore>({
    ready: false,
    path: { state: "", config: "", worktree: "", directory: "", home: "" },
    project: projectCache.value,
    session_todo: {},
    pendingQuestions: {},
    provider: { all: [], connected: [], default: {} },
    provider_auth: {},
    config: {},
    reload: undefined,
  })
  const queryClient = useQueryClient()

  let active = true
  let projectWritten = false
  let bootedAt = 0
  let bootingRoot = false
  let eventFrame: number | undefined
  let eventTimer: ReturnType<typeof setTimeout> | undefined

  onCleanup(() => {
    active = false
  })
  onCleanup(() => {
    if (eventFrame !== undefined) cancelAnimationFrame(eventFrame)
    if (eventTimer !== undefined) clearTimeout(eventTimer)
  })

  const cacheProjects = () => {
    setProjectCache(
      "value",
      untrack(() => globalStore.project.map(sanitizeProject)),
    )
  }

  const setProjects = (next: Project[] | ((draft: Project[]) => void)) => {
    projectWritten = true
    if (typeof next === "function") {
      setGlobalStore("project", produce(next))
      cacheProjects()
      return
    }
    setGlobalStore("project", next)
    cacheProjects()
  }

  const setBootStore = ((...input: unknown[]) => {
    if (input[0] === "project" && Array.isArray(input[1])) {
      setProjects(input[1] as Project[])
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  const set = ((...input: unknown[]) => {
    if (input[0] === "project" && (Array.isArray(input[1]) || typeof input[1] === "function")) {
      setProjects(input[1] as Project[] | ((draft: Project[]) => void))
      return input[1]
    }
    return (setGlobalStore as (...args: unknown[]) => unknown)(...input)
  }) as typeof setGlobalStore

  if (projectInit instanceof Promise) {
    void projectInit
      .then(() => {
        if (!active) return
        if (projectWritten) return
        const cached = projectCache.value
        if (cached.length === 0) return
        setGlobalStore("project", cached)
      })
      .catch(() => {
        // Project init failed — ignore; the sync loop will retry
      })
  }

  const acceptSessionTodo = (sessionID: string, incoming: SessionTodoSnapshot): boolean => {
    if (!sessionID) return false
    const current = globalStore.session_todo[sessionID]
    if (!canAcceptSessionTodo(current, incoming)) return false
    setSessionTodoSnapshot(setGlobalStore, sessionID, current, incoming)
    return true
  }

  const clearSessionTodoAuthoritative = (sessionID: string) => {
    if (!sessionID) return
    setGlobalStore(
      "session_todo",
      produce((draft) => {
        delete draft[sessionID]
      }),
    )
  }

  const setSessionTodo = (
    sessionID: string,
    value: Todo[] | SessionTodoSnapshot | undefined,
  ) => {
    if (!sessionID) return
    if (!value) {
      clearSessionTodoAuthoritative(sessionID)
      return
    }
    const snapshot = Array.isArray(value) ? { revision: 0, todos: value } : value
    acceptSessionTodo(sessionID, snapshot)
  }

  const paused = () => untrack(() => globalStore.reload) !== undefined

  const queue = createRefreshQueue({
    paused,
    bootstrap,
    bootstrapInstance,
  })

  const children = createChildStoreManager({
    owner,
    isBooting: (directory) => booting.has(directory),
    isLoadingSessions: (directory) => sessionLoads.has(directory),
    onBootstrap: (directory) => {
      void bootstrapInstance(directory)
    },
    onDispose: (directory) => {
      queue.clear(directory)
      sessionMeta.delete(directory)
      blockerTerminals.clearDirectory(directory)
      todoHydrate.clearDirectory(directory)
      sdkCache.delete(directory)
      clearProviderRev(directory)
      clearSessionPrefetchDirectory(directory)
    },
    translate: language.t,
  })

  // Owns the global pending-question index (see GlobalStore.pendingQuestions).
  // resolveParentID walks one step up the session tree to attribute a question
  // to its root session: in-memory for an open project, falling back to the
  // network for a background project whose sessions were never bootstrapped.
  const questions = createPendingQuestionController({
    read: () => globalStore.pendingQuestions,
    write: (mutate) => setGlobalStore("pendingQuestions", produce(mutate)),
    resolveParentID: (directory, sessionID) => {
      const existing = children.peekExisting(directory)
      const local = existing?.[0].session.find((session) => session.id === sessionID)
      if (local) return local.parentID
      return globalSDK.client.session
        .get({ directory, sessionID })
        .then((result) => result.data?.parentID)
        .catch(() => undefined)
    },
  })

  const sdkFor = (directory: string) => {
    const cached = sdkCache.get(directory)
    if (cached) return cached
    const sdk = globalSDK.createClient({
      directory,
      throwOnError: true,
    })
    sdkCache.set(directory, sdk)
    return sdk
  }

  async function loadSessions(directory: string) {
    const pending = sessionLoads.get(directory)
    if (pending) return pending

    children.pin(directory)
    const [store, setStore] = children.child(directory, { bootstrap: false })
    const meta = sessionMeta.get(directory)
    if (meta && meta.limit >= store.limit) {
      const next = trimSessions(store.session, {
        limit: store.limit,
        permission: store.permission,
        preserveSessionIDs: pendingSessionIDsForDirectory(globalStore.pendingQuestions, directory),
      })
      if (next.length !== store.session.length) {
        cleanupDroppedSessionCaches(store, setStore, next, {
          onDropSession: (sessionID) => todoHydrate.invalidate(directory, sessionID),
        })
        setStore("session", reconcile(next, { key: "id" }))
      }
      children.unpin(directory)
      return
    }

    const limit = Math.max(store.limit + SESSION_RECENT_LIMIT, SESSION_RECENT_LIMIT)
    const promise = queryClient
      .fetchQuery({
        ...loadSessionsQuery(directory),
        queryFn: () =>
          loadRootSessionsWithFallback({
            directory,
            limit,
            list: (query) => globalSDK.client.session.list(query),
          })
            .then((x) => {
              const nonArchived = (x.data ?? [])
                .filter((s) => !!s?.id)
                .filter((s) => !s.time?.archived)
                .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
              const limit = store.limit
              const childSessions = store.session.filter((s) => !!s.parentID)
              const sessions = trimSessions([...nonArchived, ...childSessions], {
                limit,
                permission: store.permission,
                preserveSessionIDs: pendingSessionIDsForDirectory(globalStore.pendingQuestions, directory),
              })
              setStore(
                "sessionTotal",
                estimateRootSessionTotal({
                  count: nonArchived.length,
                  limit: x.limit,
                  limited: x.limited,
                }),
              )
              cleanupDroppedSessionCaches(store, setStore, sessions, {
                onDropSession: (sessionID) => todoHydrate.invalidate(directory, sessionID),
              })
              setStore("session", reconcile(sessions, { key: "id" }))
              sessionMeta.set(directory, { limit })
            })
            .catch((err) => {
              console.error("Failed to load sessions", err)
              const project = getFilename(directory)
              showToast({
                variant: "error",
                title: language.t("toast.session.listFailed.title", { project }),
                description: formatServerError(err, language.t),
              })
            })
            .then(() => null),
      })
      .then(() => {})

    sessionLoads.set(directory, promise)
    void promise.finally(() => {
      sessionLoads.delete(directory)
      children.unpin(directory)
    })
    return promise
  }

  async function loadAutomationRuns(directory: string, automationID: string, options?: { cursor?: string }) {
    if (!directory || !automationID) return
    children.pin(directory)
    try {
      const [store, setStore] = children.peek(directory, { bootstrap: false })
      const sdk = sdkFor(directory)
      const res = await sdk.automation.runs({ automationID, ...(options?.cursor ? { cursor: options.cursor } : {}) })
      mergeAutomationRuns(store, setStore, res.data?.items ?? [])
      return res.data?.nextCursor ?? null
    } finally {
      children.unpin(directory)
    }
  }

  // Mutations apply the authoritative response immediately (revision-gated), so
  // the UI reflects the change without waiting for the SSE round-trip; the
  // matching event then no-ops as an equal revision.
  async function pauseAutomation(directory: string, automationID: string) {
    children.pin(directory)
    try {
      const [store, setStore] = children.peek(directory, { bootstrap: false })
      const res = await sdkFor(directory).automation.pause({ automationID })
      if (res.data) applyAutomationDefinition(store, setStore, res.data)
    } finally {
      children.unpin(directory)
    }
  }

  async function resumeAutomation(directory: string, automationID: string) {
    children.pin(directory)
    try {
      const [store, setStore] = children.peek(directory, { bootstrap: false })
      const res = await sdkFor(directory).automation.resume({ automationID })
      if (res.data) applyAutomationDefinition(store, setStore, res.data)
    } finally {
      children.unpin(directory)
    }
  }

  async function deleteAutomation(directory: string, automationID: string) {
    children.pin(directory)
    try {
      const [store, setStore] = children.peek(directory, { bootstrap: false })
      const res = await sdkFor(directory).automation.delete({ automationID })
      if (res.data) applyAutomationTombstone(store, setStore, res.data)
    } finally {
      children.unpin(directory)
    }
  }

  async function runAutomationNow(directory: string, automationID: string) {
    children.pin(directory)
    try {
      const [store, setStore] = children.peek(directory, { bootstrap: false })
      const res = await sdkFor(directory).automation.runNow({ automationID })
      if (res.data) applyAutomationRun(store, setStore, res.data)
      return res.data
    } finally {
      children.unpin(directory)
    }
  }

  // create echoes the resolved definition (with normalizationWarnings); apply it
  // immediately so the panel reflects the new automation before the SSE event.
  async function createAutomation(directory: string, input: AutomationCreateInput) {
    children.pin(directory)
    try {
      const [store, setStore] = children.peek(directory, { bootstrap: false })
      const res = await sdkFor(directory).automation.create({ automationCreateInput: input })
      if (res.data) applyAutomationDefinition(store, setStore, res.data)
      return res.data
    } finally {
      children.unpin(directory)
    }
  }

  async function updateAutomation(directory: string, automationID: string, patch: AutomationUpdateInput) {
    children.pin(directory)
    try {
      const [store, setStore] = children.peek(directory, { bootstrap: false })
      const res = await sdkFor(directory).automation.update({ automationID, automationUpdateInput: patch })
      if (res.data) applyAutomationDefinition(store, setStore, res.data)
      return res.data
    } finally {
      children.unpin(directory)
    }
  }

  async function moveAutomation(directory: string, automationID: string, targetProject: { id: string; worktree: string }) {
    children.pin(directory)
    children.pin(targetProject.worktree)
    try {
      const source = children.peek(directory, { bootstrap: false })
      const current = source[0].automation[automationID]
      const res = await sdkFor(directory).automation.update({
        automationID,
        automationUpdateInput: {
          where: {
            projectID: targetProject.id,
            ...(current?.where.worktree ? { worktree: current.where.worktree } : {}),
          },
        },
      })
      if (res.data) {
        const target = children.peek(targetProject.worktree, { bootstrap: false })
        applyAutomationMoveResult({
          source,
          target,
          automationID,
          targetProjectID: targetProject.id,
          incoming: res.data,
        })
      }
      return res.data
    } finally {
      children.unpin(targetProject.worktree)
      children.unpin(directory)
    }
  }

  async function bootstrapInstance(directory: string) {
    if (!directory) return
    const pending = booting.get(directory)
    if (pending) return pending

    children.pin(directory)
    const promise = Promise.resolve().then(async () => {
      const child = children.ensureChild(directory)
      const cache = children.vcsCache.get(directory)
      if (!cache) return
      const sdk = sdkFor(directory)
      await bootstrapDirectory({
        directory,
        global: {
          config: globalStore.config,
          path: globalStore.path,
          project: globalStore.project,
          provider: globalStore.provider,
        },
        sdk,
        store: child[0],
        setStore: child[1],
        vcsCache: cache,
        loadSessions,
        translate: language.t,
        queryClient,
        pendingQuestions: { reconcile: questions.reconcile },
      })
    })

    booting.set(directory, promise)
    void promise.finally(() => {
      booting.delete(directory)
      children.unpin(directory)
    })
    return promise
  }

  const unsub = globalSDK.event.listen((e) => {
    const directory = e.name
    const event = e.details
    const recent = bootingRoot || Date.now() - bootedAt < 1500

    if (directory === "global") {
      applyGlobalEvent({
        event,
        project: globalStore.project,
        refresh: () => {
          if (recent) return
          queue.refresh()
        },
        setGlobalProject: setProjects,
      })
      if (event.type === "server.connected") {
        todoHydrate.markGlobalRecovery()
        for (const directory of Object.keys(children.children)) {
          queue.push(directory)
        }
      }
      if (event.type === "global.disposed") {
        if (recent) return
        todoHydrate.markGlobalRecovery()
        for (const directory of Object.keys(children.children)) {
          queue.push(directory)
        }
      }
      return
    }

    // Maintain the global pending-question index for every directory event,
    // including detached background projects that have no child store.
    questions.applyEvent(directory, event)

    const targets = directoryEventTargets({
      directory,
      event,
      hasChild: (targetDirectory) => !!children.children[targetDirectory],
    })
    let applied = false

    for (const targetDirectory of targets) {
      const existing = children.children[targetDirectory]
      if (!existing) continue
      applied = true
      children.mark(targetDirectory)
      const [store, setStore] = existing
      applyDirectoryEvent({
        event,
        directory: targetDirectory,
        store,
        setStore,
        push: queue.push,
        acceptSessionTodo,
        clearSessionTodoAuthoritative,
        todoHydrate,
        blockerTerminals,
        vcsCache: children.vcsCache.get(targetDirectory),
        onAutomationFailureStreak: (definition) => {
          showToast({
            variant: "subtle",
            title: language.t("automations.toast.failureStreak.title"),
            description: language.t("automations.toast.failureStreak.description", {
              title: definition.title,
              count: definition.failureStreak,
            }),
          })
        },
        loadLsp: () => {
          void sdkFor(targetDirectory)
            .lsp.status()
            .then((x) => {
              setStore("lsp", x.data ?? [])
              setStore("lsp_ready", true)
            })
        },
      })
    }

    if (!applied) {
      applyDetachedDirectoryEvent({
        directory,
        event,
        acceptSessionTodo,
        clearSessionTodoAuthoritative,
        todoHydrate,
      })
      return
    }

    if ((event.type as string) === "lsp.server.install.failed") {
      const properties = (
        event as unknown as { properties?: { add?: string[]; dir?: string; error?: string } }
      ).properties
      showToast({
        variant: "error",
        title: language.t("toast.lsp.installFailed.title"),
        description: language.t("toast.lsp.installFailed.description", {
          pkg: properties?.add?.[0] ?? properties?.dir ?? "unknown",
          error: properties?.error ?? "",
        }),
      })
    }
  })

  onCleanup(unsub)
  onCleanup(() => {
    queue.dispose()
  })
  onCleanup(() => {
    for (const directory of Object.keys(children.children)) {
      children.disposeDirectory(directory)
    }
  })

  async function bootstrap() {
    bootingRoot = true
    try {
      await bootstrapGlobal({
        globalSDK: globalSDK.client,
        requestFailedTitle: language.t("common.requestFailed"),
        translate: language.t,
        formatMoreCount: (count) => language.t("common.moreCountSuffix", { count }),
        setGlobalStore: setBootStore,
        queryClient,
      })
      bootedAt = Date.now()
    } finally {
      bootingRoot = false
    }
  }

  onMount(() => {
    if (typeof requestAnimationFrame === "function") {
      eventFrame = requestAnimationFrame(() => {
        eventFrame = undefined
        if (!active) return
        eventTimer = setTimeout(() => {
          eventTimer = undefined
          void globalSDK.event.start()
        }, 0)
      })
    } else {
      eventTimer = setTimeout(() => {
        eventTimer = undefined
        void globalSDK.event.start()
      }, 0)
    }
    void bootstrap()
  })

  const projectApi = {
    loadSessions,
    meta(directory: string, patch: ProjectMeta) {
      children.projectMeta(directory, patch)
    },
    icon(directory: string, value: string | undefined) {
      children.projectIcon(directory, value)
    },
  }

  const retainDirectory = (directory: string) => {
    children.pin(directory)
    let released = false
    try {
      const [store, setStore] = children.peek(directory, { bootstrap: false })
      return {
        directory,
        store,
        setStore,
        release() {
          if (released) return
          released = true
          children.unpin(directory)
        },
      }
    } catch (err) {
      children.unpin(directory)
      throw err
    }
  }

  const updateConfig = async (config: Config) => {
    setGlobalStore("reload", "pending")
    const actionClient = globalSDK.createClient({
      headers: clientActionHeaders({ kind: "global.config.update" }),
      throwOnError: true,
    })
    return actionClient.global.config
      .update({ config })
      .then(bootstrap)
      .then(() => {
        queue.refresh()
        setGlobalStore("reload", undefined)
        queue.refresh()
      })
      .catch((error) => {
        setGlobalStore("reload", undefined)
        throw error
      })
  }

  return {
    data: globalStore,
    set,
    get ready() {
      return globalStore.ready
    },
    get error() {
      return globalStore.error
    },
    child: children.child,
    peek: children.peek,
    peekExisting: children.peekExisting,
    mountedDirectories: children.directories,
    retainDirectory,
    // Register a rising-edge side effect for live question arrivals (the
    // notification provider hooks OS notify / sound / Dock attention here).
    onQuestionAlert: questions.onAlert,
    bootstrap,
    updateConfig,
    project: projectApi,
    automation: {
      create: createAutomation,
      update: updateAutomation,
      move: moveAutomation,
      loadRuns: loadAutomationRuns,
      pause: pauseAutomation,
      resume: resumeAutomation,
      delete: deleteAutomation,
      runNow: runAutomationNow,
    },
    todo: {
      set: setSessionTodo,
      accept: acceptSessionTodo,
      clearAuthoritative: clearSessionTodoAuthoritative,
    },
    todoHydrate,
  }
}

const GlobalSyncContext = createContext<ReturnType<typeof createGlobalSync>>()

export function GlobalSyncProvider(props: ParentProps) {
  const value = createGlobalSync()
  return <GlobalSyncContext.Provider value={value}>{props.children}</GlobalSyncContext.Provider>
}

export function useGlobalSync() {
  const context = useContext(GlobalSyncContext)
  if (!context) throw new Error("useGlobalSync must be used within GlobalSyncProvider")
  return context
}
