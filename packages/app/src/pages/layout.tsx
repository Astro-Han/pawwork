import {
  batch,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  ParentProps,
  Show,
  untrack,
  type Accessor,
} from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import { useLocation, useNavigate, useParams } from "@solidjs/router"
import { useLayout, LocalProject } from "@/context/layout"
import { useGlobalSync } from "@/context/global-sync"
import { Persist, persisted } from "@/utils/persist"
import { base64Encode } from "@opencode-ai/util/encode"
import { decode64 } from "@/utils/base64"
import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { getFilename } from "@opencode-ai/util/path"
import { Session, type GlobalSession, type Message } from "@opencode-ai/sdk/v2/client"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { createStore, produce, reconcile } from "solid-js/store"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { useProviders } from "@/hooks/use-providers"
import { showToast, toaster } from "@opencode-ai/ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { clientActionHeaders } from "@/utils/server"
import { LayoutPageContext } from "@/context/layout-page"
import { ShellSurfaceContext } from "@/context/shell-surface"
import { clearWorkspaceTerminals, isTerminalGoneError } from "@/context/terminal"
import { dropSessionCaches, pickSessionCacheEvictions } from "@/context/global-sync/session-cache"
import {
  clearSessionPrefetchInflight,
  clearSessionPrefetch,
  getSessionPrefetch,
  isSessionPrefetchCurrent,
  runSessionPrefetch,
  setSessionPrefetch,
  shouldSkipSessionPrefetch,
} from "@/context/global-sync/session-prefetch"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { Binary } from "@opencode-ai/util/binary"
import { retry } from "@opencode-ai/util/retry"
import { playSoundById } from "@/utils/sound"
import { setNavigate } from "@/utils/notification-click"
import { setOpenSettings } from "@/utils/settings-navigation"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { setSessionHandoff } from "@/pages/session/handoff"
import { usePinnedDraft } from "@/components/prompt-input/pinned-draft"
import {
  runHomepageMigration,
  HOMEPAGE_MIGRATION_SENTINEL_KEY,
  type LegacyHomepagePromptStore,
} from "@/components/prompt-input/homepage-migration"
import { usePortableDraft } from "@/components/prompt-input/portable-draft"
import { createMigrationStorageIO } from "@/components/prompt-input/homepage-migration-storage"

import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { useCommand } from "@/context/command"
import { getDraggableId } from "@/utils/solid-dnd"
import { useServer } from "@/context/server"
import { useLanguage } from "@/context/language"
import {
  displayName,
  effectiveWorkspaceOrder,
  errorMessage,
  openProjectRoute,
  startupAutoselectDirectory,
  sortedRootSessions,
  workspaceKey,
} from "./layout/helpers"
import {
  collectNewSessionDeepLinks,
  collectOpenProjectDeepLinks,
  deepLinkEvent,
  drainPendingDeepLinks,
} from "./layout/deep-links"
import { createInlineEditorController } from "./layout/inline-editor"
import {
  buildPawworkSidebarSessionRows,
  pawworkSessionRouteUnhideKeys,
  pawworkSessionDirectories,
  resolvePawworkProjectRenameTarget,
  resolvePawworkSessionProjectKey,
  resolvePawworkSessionProjectLabel,
  sortPawworkSidebarSessions,
} from "./layout/pawwork-session-source"
import {
  buildPawworkSessionSections,
  findPawworkSessionNavigationTarget,
  flattenPawworkSessionSections,
  reorderPawworkPinnedByVisible,
  unpinPawworkSession,
} from "./layout/pawwork-session-nav"
import { createShellNavigation } from "./layout/shell-navigation"
import { useUpdatePolling } from "./layout/layout-update-polling"
import { sessionNotificationHref, useSDKNotificationToasts } from "./layout/layout-sdk-event-effects"
import { registerLayoutCommands } from "./layout/layout-commands"
import { LayoutShellFrame } from "./layout/layout-shell-frame"
import {
  buildPawworkSessionWindow,
  nextPawworkSessionWindowLimit,
  type PawworkWindowSession,
  PAWWORK_SESSION_WINDOW_INITIAL,
  pawworkSessionWindowActiveRoot,
  sortPawworkSessionWindowSessions,
} from "./layout/pawwork-session-window"
import { type WorkspaceSidebarContext } from "./layout/sidebar-workspace"
import { PawworkSidebar, type PawworkSidebarSession } from "./layout/pawwork-sidebar"
import { AutomationsSurface } from "@/pages/automations/automations-surface"
import { createDefaultLayoutPageState, createLayoutPagePersistTarget, removePinnedSessionIDs } from "./layout/layout-page-store"
import { SettingsContent, SettingsNav, isSettingsTab, type SettingsTab } from "@/pages/settings/settings-shell"
import { DialogDeleteSession } from "@/components/dialog-delete-session"
import { AppStartupPending } from "@/components/app-startup-pending"
import { sessionTitle } from "@/utils/session-title"
import { sizingStopEvents } from "@/pages/session/helpers"

export default function Layout(props: ParentProps) {
  const [store, setStore, , ready] = persisted(
    createLayoutPagePersistTarget(),
    createStore(createDefaultLayoutPageState()),
  )

  const pageReady = createMemo(() => ready())

  let scrollContainerRef: HTMLDivElement | undefined
  let dialogRun = 0
  let dialogDead = false
  // One mutually-exclusive shell surface at a time. Settings replaces the
  // sidebar + main; automations only takes over main (sidebar stays live).
  const [activeSurface, setActiveSurface] = createSignal<"none" | "settings" | "automations">("none")
  const settingsOpen = createMemo(() => activeSurface() === "settings")
  const automationsOpen = createMemo(() => activeSurface() === "automations")
  const [settingsTab, setSettingsTab] = createSignal<SettingsTab>("general")

  const params = useParams()
  const location = useLocation()
  const globalSDK = useGlobalSDK()
  const globalSync = useGlobalSync()
  const layout = useLayout()
  const layoutReady = createMemo(() => layout.ready())
  const platform = usePlatform()
  const settings = useSettings()
  const server = useServer()
  const notification = useNotification()
  const permission = usePermission()
  const navigate = useNavigate()
  // Wrap navigate so non-shell entry points (notification clicks, deep links
  // dispatched through @/utils/notification-click) also close the settings
  // overlay before routing. Shell-driven navigation (openNewSession /
  // openSession) closes settings explicitly through closeSettingsSurface.
  setNavigate((href) => {
    closeSettings()
    navigate(href)
  })
  setOpenSettings((tab) => openSettings(tab))
  const providers = useProviders()
  const dialog = useDialog()
  const command = useCommand()
  const theme = useTheme()
  const language = useLanguage()
  const initialDirectory = decode64(params.dir)
  const route = createMemo(() => {
    const slug = params.dir
    if (!slug) return { slug, dir: "" }
    const dir = decode64(slug)
    if (!dir) return { slug, dir: "" }
    return {
      slug,
      dir: globalSync.peek(dir, { bootstrap: false })[0].path.directory || dir,
    }
  })
  const currentDir = createMemo(() => route().dir)
  const pawworkSidebar = createMemo(() => globalSync.data.project.length <= 1)

  const [state, setState] = createStore({
    autoselect: !initialDirectory,
    busyWorkspaces: {} as Record<string, boolean>,
    scrollSessionKey: undefined as string | undefined,
    sizing: false,
  })

  const editor = createInlineEditorController()
  const setBusy = (directory: string, value: boolean) => {
    const key = workspaceKey(directory)
    if (value) {
      setState("busyWorkspaces", key, true)
      return
    }
    setState(
      "busyWorkspaces",
      produce((draft) => {
        delete draft[key]
      }),
    )
  }
  const isBusy = (directory: string) => !!state.busyWorkspaces[workspaceKey(directory)]
  let sizet: number | undefined

  onCleanup(() => {
    dialogDead = true
    dialogRun += 1
    if (sizet !== undefined) clearTimeout(sizet)
  })

  onMount(() => {
    const stop = () => setState("sizing", false)
    for (const event of sizingStopEvents) makeEventListener(window, event, stop)
  })

  createEffect(() => {
    if (!state.autoselect) return
    const dir = params.dir
    if (!dir) return
    const directory = decode64(dir)
    if (!directory) return
    setState("autoselect", false)
  })

  const editorOpen = editor.editorOpen
  const openEditor = editor.openEditor
  const closeEditor = editor.closeEditor
  const setEditor = editor.setEditor
  const InlineEditor = editor.InlineEditor

  useUpdatePolling({
    platform,
    settings,
    copy: language,
    effects: {
      showToast,
    },
  })
  useSDKNotificationToasts({
    route: {
      currentDirectory: currentDir,
      currentSessionID: () => params.id,
      sessionHref: sessionNotificationHref,
    },
    sdk: {
      listen: globalSDK.event.listen,
      sessions: (directory) => globalSync.child(directory, { bootstrap: false })[0].session,
    },
    settings: {
      notify: {
        level: settings.notify.level,
      },
    },
    permission: {
      autoResponds: (request, directory) => permission.autoResponds(request, directory),
    },
    effects: {
      notify: (title, description, href) => platform.notify(title, description, href),
      playSound: playSoundById,
      setBusy,
      worktreeReady: (directory) => WorktreeState.ready(directory),
      worktreeFailed: (directory, message) => WorktreeState.failed(directory, message),
    },
    copy: language,
  })

  function scrollToSession(sessionId: string, sessionKey: string) {
    if (!scrollContainerRef) return
    if (state.scrollSessionKey === sessionKey) return
    const element = scrollContainerRef.querySelector(`[data-session-id="${sessionId}"]`)
    if (!element) return
    const containerRect = scrollContainerRef.getBoundingClientRect()
    const elementRect = element.getBoundingClientRect()
    if (elementRect.top >= containerRect.top && elementRect.bottom <= containerRect.bottom) {
      setState("scrollSessionKey", sessionKey)
      return
    }
    setState("scrollSessionKey", sessionKey)
    element.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }

  const currentProject = createMemo(() => {
    const directory = currentDir()
    if (!directory) return
    const key = workspaceKey(directory)

    const projects = layout.projects.list()

    const sandbox = projects.find((p) => p.sandboxes?.some((item) => workspaceKey(item) === key))
    if (sandbox) return sandbox

    const direct = projects.find((p) => workspaceKey(p.worktree) === key)
    if (direct) return direct

    const [child] = globalSync.child(directory, { bootstrap: false })
    const id = child.project
    if (!id) return

    const meta = globalSync.data.project.find((p) => p.id === id)
    const root = meta?.worktree
    if (!root) return

    return projects.find((p) => p.worktree === root)
  })
  const [autoselecting] = createResource(async () => {
    await ready.promise
    await layout.ready.promise
    // Wait for globalSync bootstrap to populate path.directory
    if (!globalSync.ready) {
      await new Promise<void>((resolve) => {
        const stop = setInterval(() => {
          if (globalSync.ready) {
            clearInterval(stop)
            resolve()
          }
        }, 50)
      })
    }
    const dir = startupAutoselectDirectory(untrack(() => state.autoselect), globalSync.data.path.directory)
    if (!dir) return
    await openProject(dir, true)
  })
  const startupAutoselectPending = () => state.autoselect && autoselecting.loading

  const workspaceName = (directory: string, projectId?: string, branch?: string) => {
    const key = workspaceKey(directory)
    const direct = store.workspaceName[key] ?? store.workspaceName[directory]
    if (direct) return direct
    if (!projectId) return
    if (!branch) return
    return store.workspaceBranchName[projectId]?.[branch]
  }

  const setWorkspaceName = (directory: string, next: string, projectId?: string, branch?: string) => {
    const key = workspaceKey(directory)
    setStore("workspaceName", key, next)
    if (!projectId) return
    if (!branch) return
    if (!store.workspaceBranchName[projectId]) {
      setStore("workspaceBranchName", projectId, {})
    }
    setStore("workspaceBranchName", projectId, branch, next)
  }

  const workspaceLabel = (directory: string, branch?: string, projectId?: string) =>
    workspaceName(directory, projectId, branch) ?? branch ?? getFilename(directory)

  const workspaceSetting = createMemo(() => {
    const project = currentProject()
    if (!project) return false
    if (project.vcs !== "git") return false
    return layout.sidebar.workspaces(project.worktree)()
  })

  const visibleSessionDirs = createMemo(() => {
    const project = currentProject()
    if (!project) return [] as string[]
    if (!workspaceSetting()) return [project.worktree]

    const activeDir = currentDir()
    return workspaceIds(project).filter((directory) => {
      const expanded = store.workspaceExpanded[directory] ?? directory === project.worktree
      const active = workspaceKey(directory) === workspaceKey(activeDir)
      return expanded || active
    })
  })

  createEffect(() => {
    if (!pageReady()) return
    if (!layoutReady()) return
    const projects = layout.projects.list()
    for (const [directory, expanded] of Object.entries(store.workspaceExpanded)) {
      if (!expanded) continue
      const key = workspaceKey(directory)
      const project = projects.find(
        (item) =>
          workspaceKey(item.worktree) === key || item.sandboxes?.some((sandbox) => workspaceKey(sandbox) === key),
      )
      if (!project) continue
      if (project.vcs === "git" && layout.sidebar.workspaces(project.worktree)()) continue
      setStore("workspaceExpanded", directory, false)
    }
  })

  const currentSessions = createMemo(() => {
    const dirs = visibleSessionDirs()
    if (dirs.length === 0) return [] as Session[]

    const result: Session[] = []
    for (const dir of dirs) {
      const [dirStore] = globalSync.child(dir, { bootstrap: true })
      const dirSessions = sortedRootSessions(dirStore)
      result.push(...dirSessions)
    }
    return result
  })

  const [pawworkSessionWindowState, setPawworkSessionWindowState] = createStore({
    limit: PAWWORK_SESSION_WINDOW_INITIAL,
    normal: [] as PawworkWindowSession[],
    pinned: [] as PawworkWindowSession[],
    active: undefined as PawworkWindowSession | undefined,
    hasMore: false,
    loading: false,
  })
  let pawworkSessionWindowRev = 0

  const findLoadedSession = (sessionID: string | undefined) => {
    if (!sessionID) return
    for (const directory of visibleSessionDirs()) {
      const [dirStore] = globalSync.child(directory, { bootstrap: false })
      const found = dirStore.session.find((session) => session.id === sessionID)
      if (found && !found.time?.archived) return found
    }
    return pawworkSessionWindowState.normal.find((session) => session.id === sessionID)
  }

  type SessionLoadResult =
    | { state: "found"; session: PawworkWindowSession }
    | { state: "gone" }
    | { state: "transient" }

  const loadSessionByIDResult = async (sessionID: string | undefined): Promise<SessionLoadResult> => {
    if (!sessionID) return { state: "gone" }
    const loaded = findLoadedSession(sessionID)
    if (loaded) return { state: "found", session: loaded }
    try {
      const response = await globalSDK.client.session.get({ sessionID })
      const session = response.data
      if (session && !session.time?.archived) return { state: "found", session }
      return { state: "gone" }
    } catch (error) {
      return isTerminalGoneError(error) ? { state: "gone" } : { state: "transient" }
    }
  }

  const loadSessionByID = async (sessionID: string | undefined) => {
    const result = await loadSessionByIDResult(sessionID)
    return result.state === "found" ? result.session : undefined
  }

  const projectKeyForSession = (session: Session | GlobalSession) => {
    return resolvePawworkSessionProjectKey(session)
  }

  const projectLabelForSession = (session: Session | GlobalSession) => {
    return resolvePawworkSessionProjectLabel(session, {
      projects: layout.projects.list(),
      workspaceName,
    })
  }

  const pawworkSessionWindow = createMemo(() =>
    buildPawworkSessionWindow({
      normal: pawworkSessionWindowState.normal,
      pinned: pawworkSessionWindowState.pinned,
      active: pawworkSessionWindowState.active,
      limit: pawworkSessionWindowState.limit,
      hasMore: pawworkSessionWindowState.hasMore,
    }),
  )

  const pawworkSessions = createMemo(() => {
    const rows = buildPawworkSidebarSessionRows(pawworkSessionWindow().sessions, {
      slugForDirectory: base64Encode,
      projectKeyForSession,
      projectLabelForSession,
      messagesForSession: (session) => {
        const tuple = globalSync.peekExisting(session.directory)
        return tuple?.[0].message[session.id]
      },
      partsForMessage: (session, messageID) => {
        const tuple = globalSync.peekExisting(session.directory)
        return tuple?.[0].part[messageID]
      },
    })
    const hidden = store.pawworkProjectHidden
    const filtered = rows.filter((row) => !hidden[row.projectKey])
    return sortPawworkSidebarSessions(filtered.map((item) => ({ ...item, id: item.session.id }))).map(({ id: _, ...item }) => item)
  })

  const pawworkSessionSections = createMemo(() =>
    buildPawworkSessionSections({
      sessions: pawworkSessions().map((item) => ({
        id: item.session.id,
        title: item.session.title ?? "",
        directory: item.session.directory,
        projectKey: item.projectKey,
        projectLabel: item.projectLabel,
        created: item.created,
      })),
      pinnedIDs: store.pawworkPinnedSessions,
      sortMode: store.pawworkSortMode,
    }),
  )

  const pawworkSessionByID = createMemo(
    () => new Map(pawworkSessions().map((item) => [item.session.id, item.session] as const)),
  )

  const pawworkNavigationSessions = createMemo(() =>
    flattenPawworkSessionSections(pawworkSessionSections())
      .map((entry) => pawworkSessionByID().get(entry.item.id))
      .filter((session): session is Session => !!session),
  )

  const mergePawworkWindowSessionMetadata = (
    session: Session | PawworkWindowSession,
    existing?: PawworkWindowSession,
  ): PawworkWindowSession => {
    const next = session as PawworkWindowSession
    return {
      ...session,
      activityAt: next.activityAt ?? existing?.activityAt,
      lastUserMessageAt: next.lastUserMessageAt ?? existing?.lastUserMessageAt,
    }
  }

  async function loadPawworkSessionWindow() {
    if (!pageReady()) return
    if (!layoutReady()) return
    if (!globalSync.ready) return
    const rev = ++pawworkSessionWindowRev
    setPawworkSessionWindowState("loading", true)
    try {
      const response = await globalSDK.client.experimental.session.list({
        roots: true,
        limit: pawworkSessionWindowState.limit,
        sort: "activity",
      })
      if (rev !== pawworkSessionWindowRev) return
      const normal = ((response.data ?? []) as PawworkWindowSession[]).filter((session) => !session.time?.archived)
      const loaded = new Map(normal.map((session) => [session.id, session]))
      const existing = new Map(
        [
          ...pawworkSessionWindowState.normal,
          ...pawworkSessionWindowState.pinned,
          ...(pawworkSessionWindowState.active ? [pawworkSessionWindowState.active] : []),
        ].map((session) => [session.id, session] as const),
      )
      const pinnedResults = await Promise.all(
        store.pawworkPinnedSessions.map(async (id) => ({
          id,
          result: loaded.has(id) ? ({ state: "found", session: loaded.get(id)! } as const) : await loadSessionByIDResult(id),
        })),
      )
      const gonePinnedIDs = new Set(pinnedResults.filter((entry) => entry.result.state === "gone").map((entry) => entry.id))
      const pinned = pinnedResults
        .map((entry) =>
          entry.result.state === "found"
            ? mergePawworkWindowSessionMetadata(entry.result.session, existing.get(entry.id))
            : undefined,
        )
        .filter((session): session is PawworkWindowSession => !!session)
      const activeID = params.id
      const active = activeID
        ? await (async () => {
            const session = loaded.get(activeID) ?? (await loadSessionByID(activeID))
            return session ? mergePawworkWindowSessionMetadata(session, existing.get(activeID)) : undefined
          })()
        : undefined
      const activeParentID = active?.parentID
      const activeParent = activeParentID
        ? await (async () => {
            const session = loaded.get(activeParentID) ?? (await loadSessionByID(activeParentID))
            return session ? mergePawworkWindowSessionMetadata(session, existing.get(activeParentID)) : undefined
          })()
        : undefined
      const activeRoot = pawworkSessionWindowActiveRoot(active, activeParent)

      if (rev !== pawworkSessionWindowRev) return
      batch(() => {
        if (gonePinnedIDs.size) {
          setStore("pawworkPinnedSessions", (current) => removePinnedSessionIDs(current, gonePinnedIDs))
        }
        setPawworkSessionWindowState("normal", reconcile(sortPawworkSessionWindowSessions(normal), { key: "id" }))
        setPawworkSessionWindowState("pinned", reconcile(pinned, { key: "id" }))
        setPawworkSessionWindowState("active", activeRoot)
        setPawworkSessionWindowState("hasMore", !!response.response?.headers.get("x-next-cursor"))
        setPawworkSessionWindowState("loading", false)
      })
    } catch (error) {
      if (rev !== pawworkSessionWindowRev) return
      setPawworkSessionWindowState("loading", false)
      showToast({
        title: language.t("toast.session.listFailed.title", { project: "PawWork" }),
        description: errorMessage(error, language.t("common.requestFailed")),
      })
    }
  }

  createEffect(
    on(
      () => [
        pageReady(),
        layoutReady(),
        globalSync.ready,
        globalSDK.url,
        pawworkSessionWindowState.limit,
        store.pawworkPinnedSessions.join("\0"),
        params.id,
      ] as const,
      () => {
        void loadPawworkSessionWindow()
      },
    ),
  )

  const upsertPawworkWindowSession = (info: Session) => {
    if (info.parentID || info.time?.archived) return
    const mergeWindowSession = (current: PawworkWindowSession[]) => {
      const existing = current.find((session) => session.id === info.id)
      const next = mergePawworkWindowSessionMetadata(info, existing)
      return sortPawworkSessionWindowSessions([...current.filter((session) => session.id !== info.id), next])
    }
    batch(() => {
      setPawworkSessionWindowState("normal", mergeWindowSession)
      if (store.pawworkPinnedSessions.includes(info.id)) {
        setPawworkSessionWindowState("pinned", mergeWindowSession)
      }
      if (params.id === info.id) {
        setPawworkSessionWindowState("active", (current) =>
          current?.id === info.id ? mergePawworkWindowSessionMetadata(info, current) : mergePawworkWindowSessionMetadata(info),
        )
      }
    })
  }

  const removePawworkWindowSession = (sessionID: string) => {
    setStore("pawworkPinnedSessions", (current) => removePinnedSessionIDs(current, new Set([sessionID])))
    setPawworkSessionWindowState("normal", (current) => current.filter((session) => session.id !== sessionID))
    setPawworkSessionWindowState("pinned", (current) => current.filter((session) => session.id !== sessionID))
    if (pawworkSessionWindowState.active?.id === sessionID) {
      setPawworkSessionWindowState("active", undefined)
    }
  }

  onCleanup(
    globalSDK.event.listen((event) => {
      const details = event.details
      if (details.type === "session.created") {
        upsertPawworkWindowSession(details.properties.info)
        return
      }
      if (details.type === "session.updated") {
        const info = details.properties.info
        if (info.time?.archived) {
          removePawworkWindowSession(info.id)
          return
        }
        upsertPawworkWindowSession(info)
        return
      }
      if (details.type === "session.deleted") {
        removePawworkWindowSession(details.properties.info.id)
      }
    }),
  )

  type PrefetchQueue = {
    inflight: Set<string>
    pending: string[]
    pendingSet: Set<string>
    running: number
  }

  const prefetchChunk = 200
  const prefetchConcurrency = 2
  const prefetchPendingLimit = 10
  const span = 4
  const prefetchToken = { value: 0 }
  const prefetchQueues = new Map<string, PrefetchQueue>()

  const PREFETCH_MAX_SESSIONS_PER_DIR = 10
  const prefetchedByDir = new Map<string, Set<string>>()

  const lruFor = (directory: string) => {
    const existing = prefetchedByDir.get(directory)
    if (existing) return existing
    const created = new Set<string>()
    prefetchedByDir.set(directory, created)
    return created
  }

  const markPrefetched = (directory: string, sessionID: string) => {
    const lru = lruFor(directory)
    return pickSessionCacheEvictions({
      seen: lru,
      keep: sessionID,
      limit: PREFETCH_MAX_SESSIONS_PER_DIR,
      preserve: params.id && workspaceKey(directory) === workspaceKey(currentDir()) ? [params.id] : undefined,
    })
  }

  createEffect(() => {
    const active = new Set(visibleSessionDirs())
    for (const directory of [...prefetchedByDir.keys()]) {
      if (active.has(directory)) continue
      prefetchedByDir.delete(directory)
    }
  })

  createEffect(() => {
    route()
    globalSDK.url

    prefetchToken.value += 1
    clearSessionPrefetchInflight()
    prefetchQueues.clear()
  })

  createEffect(() => {
    const visible = new Set(visibleSessionDirs())
    for (const [directory, q] of prefetchQueues) {
      if (visible.has(directory)) continue
      q.pending.length = 0
      q.pendingSet.clear()
      if (q.running === 0) prefetchQueues.delete(directory)
    }
  })

  const queueFor = (directory: string) => {
    const existing = prefetchQueues.get(directory)
    if (existing) return existing

    const created: PrefetchQueue = {
      inflight: new Set(),
      pending: [],
      pendingSet: new Set(),
      running: 0,
    }
    prefetchQueues.set(directory, created)
    return created
  }

  const mergeByID = <T extends { id: string }>(current: T[], incoming: T[]) => {
    if (current.length === 0) {
      return incoming.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    }

    const map = new Map<string, T>()
    for (const item of current) {
      map.set(item.id, item)
    }
    for (const item of incoming) {
      map.set(item.id, item)
    }
    return [...map.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  async function prefetchMessages(directory: string, sessionID: string, token: number) {
    const [store, setStore] = globalSync.child(directory, { bootstrap: false })

    return runSessionPrefetch({
      directory,
      sessionID,
      task: (rev) =>
        retry(() => globalSDK.client.session.messages({ directory, sessionID, limit: prefetchChunk }))
          .then((messages) => {
            if (prefetchToken.value !== token) return
            if (!isSessionPrefetchCurrent(directory, sessionID, rev)) return

            const items = (messages.data ?? []).filter((x) => !!x?.info?.id)
            const next = items.map((x) => x.info).filter((m): m is Message => !!m?.id)
            const sorted = mergeByID([], next)
            const stale = markPrefetched(directory, sessionID)
            const cursor = messages.response?.headers.get("x-next-cursor") ?? undefined
            const meta = {
              limit: sorted.length,
              cursor,
              complete: !cursor,
              at: Date.now(),
            }

            if (stale.length > 0) {
              clearSessionPrefetch(directory, stale)
            }

            const current = store.message[sessionID] ?? []
            const merged = mergeByID(
              current.filter((item): item is Message => !!item?.id),
              sorted,
            )

            if (!isSessionPrefetchCurrent(directory, sessionID, rev)) return

            batch(() => {
              if (stale.length > 0) {
                setStore(
                  produce((draft) => {
                    dropSessionCaches(draft, stale)
                  }),
                )
              }

              setStore("message", sessionID, reconcile(merged, { key: "id" }))
              setSessionPrefetch({ directory, sessionID, ...meta })

              for (const message of items) {
                const currentParts = store.part[message.info.id] ?? []
                const mergedParts = mergeByID(
                  currentParts.filter((item): item is (typeof currentParts)[number] & { id: string } => !!item?.id),
                  message.parts.filter((item): item is (typeof message.parts)[number] & { id: string } => !!item?.id),
                )

                setStore("part", message.info.id, reconcile(mergedParts, { key: "id" }))
              }
            })

            return meta
          })
          .catch(() => undefined),
    })
  }

  const pumpPrefetch = (directory: string) => {
    const q = queueFor(directory)
    if (q.running >= prefetchConcurrency) return

    const sessionID = q.pending.shift()
    if (!sessionID) return

    q.pendingSet.delete(sessionID)
    q.inflight.add(sessionID)
    q.running += 1

    const token = prefetchToken.value

    void prefetchMessages(directory, sessionID, token).finally(() => {
      q.running -= 1
      q.inflight.delete(sessionID)
      pumpPrefetch(directory)
    })
  }

  const prefetchSession = (session: Session, priority: "high" | "low" = "low") => {
    const directory = session.directory
    if (!directory) return

    const [store] = globalSync.child(directory, { bootstrap: false })
    const cached = untrack(() => {
      const info = getSessionPrefetch(directory, session.id)
      return shouldSkipSessionPrefetch({
        message: store.message[session.id] !== undefined,
        info,
        chunk: prefetchChunk,
      })
    })
    if (cached) return

    const q = queueFor(directory)
    if (q.inflight.has(session.id)) return
    if (q.pendingSet.has(session.id)) {
      if (priority !== "high") return
      const index = q.pending.indexOf(session.id)
      if (index > 0) {
        q.pending.splice(index, 1)
        q.pending.unshift(session.id)
      }
      return
    }

    const lru = lruFor(directory)
    const known = lru.has(session.id)
    if (!known && lru.size >= PREFETCH_MAX_SESSIONS_PER_DIR && priority !== "high") return

    if (priority === "high") q.pending.unshift(session.id)
    if (priority !== "high") q.pending.push(session.id)
    q.pendingSet.add(session.id)

    while (q.pending.length > prefetchPendingLimit) {
      const dropped = q.pending.pop()
      if (!dropped) continue
      q.pendingSet.delete(dropped)
    }

    pumpPrefetch(directory)
  }

  const warm = (sessions: Session[], index: number) => {
    for (let offset = 1; offset <= span; offset++) {
      const next = sessions[index + offset]
      if (next) prefetchSession(next, offset === 1 ? "high" : "low")

      const prev = sessions[index - offset]
      if (prev) prefetchSession(prev, offset === 1 ? "high" : "low")
    }
  }

  createEffect(() => {
    const sessions = pawworkNavigationSessions()
    if (sessions.length === 0) return

    const index = params.id ? sessions.findIndex((s) => s.id === params.id) : 0
    if (index === -1) return

    if (!params.id) {
      const first = sessions[index]
      if (first) prefetchSession(first, "high")
    }

    warm(sessions, index)
  })

  function navigateSessionByOffset(offset: number) {
    const target = findPawworkSessionNavigationTarget({
      sections: pawworkSessionSections(),
      currentSessionID: params.id,
      offset,
    })
    if (!target) return

    const session = pawworkSessionByID().get(target.item.id)
    if (!session) return

    const sessions = pawworkNavigationSessions()
    const targetIndex = sessions.findIndex((item) => item.id === session.id)

    expandPawworkProjectGroup(target.groupKey)
    prefetchSession(session, "high")
    if (targetIndex !== -1) warm(sessions, targetIndex)

    navigateToSession(session)
  }

  function navigateProjectByOffset(offset: number) {
    const projects = layout.projects.list()
    if (projects.length === 0) return

    const current = currentProject()?.worktree
    const fallback = currentDir() ? projectRoot(currentDir()) : undefined
    const active = current ?? fallback
    const index = active ? projects.findIndex((project) => project.worktree === active) : -1

    const target =
      index === -1
        ? offset > 0
          ? projects[0]
          : projects[projects.length - 1]
        : projects[(index + offset + projects.length) % projects.length]
    if (!target) return

    // warm up child store to prevent flicker
    globalSync.child(target.worktree)
    openProject(target.worktree)
  }

  function navigateSessionByUnseen(offset: number) {
    const target = findPawworkSessionNavigationTarget({
      sections: pawworkSessionSections(),
      currentSessionID: params.id,
      offset,
      include: (item) => notification.session.unseenCount(item.id) > 0,
    })
    if (!target) return

    const session = pawworkSessionByID().get(target.item.id)
    if (!session) return

    const sessions = pawworkNavigationSessions()
    const targetIndex = sessions.findIndex((item) => item.id === session.id)

    expandPawworkProjectGroup(target.groupKey)
    prefetchSession(session, "high")
    if (targetIndex !== -1) warm(sessions, targetIndex)

    navigateToSession(session)
  }

  async function renamePawworkSession(session: Session, next: string) {
    const title = next.trim()
    if (!title || title === (session.title ?? "")) return

    try {
      await globalSDK.client.session.update({
        directory: session.directory,
        sessionID: session.id,
        title,
      })

      const [, setStore] = globalSync.child(session.directory)
      setStore(
        produce((draft) => {
          const match = Binary.search(draft.session, session.id, (item) => item.id)
          if (match.found) draft.session[match.index].title = title
        }),
      )
    } catch (error) {
      showToast({
        title: language.t("common.requestFailed"),
        description: errorMessage(error, language.t("common.requestFailed")),
      })
    }
  }

  function togglePinnedSession(sessionID: string) {
    setStore("pawworkPinnedSessions", (current) => {
      const next = current.filter((id) => id !== sessionID)
      if (next.length !== current.length) return next
      return [sessionID, ...current]
    })
  }

  /**
   * Cross-zone drag: All ⇄ Pinned with positional insert, or intra-Pinned
   * reorder. `visiblePinnedIDs` is the rendered pinned order from the sidebar;
   * `visibleTargetIndex` is a slot inside it. We translate to the raw
   * pinned array so hidden / un-loaded pinned IDs keep their positions.
   */
  function dragPawworkSession(input: {
    sessionID: string
    targetSection: "pinned" | "recent"
    visiblePinnedIDs: string[]
    visibleTargetIndex: number
  }) {
    setStore("pawworkPinnedSessions", (current) => {
      if (input.targetSection === "recent") {
        return unpinPawworkSession({ pinnedIDs: current, sourceID: input.sessionID })
      }
      return reorderPawworkPinnedByVisible({
        pinnedIDs: current,
        visiblePinnedIDs: input.visiblePinnedIDs,
        sourceID: input.sessionID,
        targetVisibleIndex: input.visibleTargetIndex,
      })
    })
  }

  /**
   * Menu-driven move up / down: keyboard-accessible reorder within the pinned
   * zone. Operates on the visible pinned order so adjacency matches what the
   * user sees; the helper reconciles back to the raw array.
   */
  function movePinnedSessionByOne(input: {
    sessionID: string
    direction: "up" | "down"
    visiblePinnedIDs: string[]
  }) {
    const visibleIndex = input.visiblePinnedIDs.indexOf(input.sessionID)
    if (visibleIndex === -1) return
    const offset = input.direction === "up" ? -1 : 1
    const nextVisibleIndex = Math.max(0, Math.min(input.visiblePinnedIDs.length - 1, visibleIndex + offset))
    if (nextVisibleIndex === visibleIndex) return
    setStore("pawworkPinnedSessions", (current) =>
      reorderPawworkPinnedByVisible({
        pinnedIDs: current,
        visiblePinnedIDs: input.visiblePinnedIDs,
        sourceID: input.sessionID,
        targetVisibleIndex: nextVisibleIndex,
      }),
    )
  }

  function setPawworkSortMode(mode: "time" | "project") {
    setStore("pawworkSortMode", mode)
  }

  function toggleProjectCollapsed(label: string) {
    const current = store.pawworkProjectCollapsed
    const next: Record<string, boolean> = { ...current }
    if (next[label]) delete next[label]
    else next[label] = true
    setStore("pawworkProjectCollapsed", reconcile(next))
  }

  function hideProject(projectKey: string) {
    if (store.pawworkProjectHidden[projectKey]) return
    setStore("pawworkProjectHidden", projectKey, true)
    showToast({
      title: language.t("project.remove.toast.title"),
      description: language.t("project.remove.toast.description"),
      actions: [
        {
          label: language.t("common.undo"),
          onClick: () => unhideProject(projectKey),
        },
      ],
    })
  }

  function unhideProject(projectKey: string) {
    if (!store.pawworkProjectHidden[projectKey]) return
    setStore(
      "pawworkProjectHidden",
      produce((draft) => {
        delete draft[projectKey]
      }),
    )
  }

  async function handleRenameProject(projectKey: string, next: string) {
    const target = resolvePawworkProjectRenameTarget(projectKey, {
      projects: layout.projects.list(),
      sessions: pawworkSessionWindow().sessions,
    })
    if (!target) return

    if (target.type === "project") {
      await renameProject(target.project, next)
      return
    }

    setWorkspaceName(target.directory, next)
  }

  function expandPawworkProjectGroup(label: string | undefined) {
    if (!label) return
    if (!store.pawworkProjectCollapsed[label]) return

    const next: Record<string, boolean> = { ...store.pawworkProjectCollapsed }
    delete next[label]
    setStore("pawworkProjectCollapsed", reconcile(next))
  }

  // Export hits the embedded sidecar via main-process IPC. When the user has
  // switched the active server to a remote target, the sidecar holds different
  // data than the UI; hide the action rather than ship a misleading export.
  const exportSessionAvailable = createMemo(
    () => !!platform.exportSession && server.current?.type === "sidecar",
  )

  async function exportSession(session: Session) {
    if (!platform.exportSession) return
    const [store] = globalSync.child(session.directory)
    const sessionInfo = store.session?.find((s) => s.id === session.id)
    const slugSource = sessionInfo?.slug ?? session.id
    const sanitized = slugSource.replace(/[\\/:*?"<>|]/g, "-").slice(0, 32)
    const slug = /[\p{L}\p{N}]/u.test(sanitized) ? sanitized : session.id.slice(-8)
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").replace(/\..+$/, "")
    const defaultName = `pawwork-session-${slug}-${stamp}.json`

    let result: { ok: true; path: string } | { ok: false; error: string }
    try {
      result = await platform.exportSession(
        session.id,
        session.directory,
        defaultName,
        language.t("session.export.action.export"),
      )
    } catch (err) {
      showToast({
        title: language.t("session.export.error.failed"),
        description: errorMessage(err, language.t("common.requestFailed")),
        variant: "error",
      })
      return
    }
    if (!result.ok) {
      if (result.error === "cancelled") return
      showToast({
        title: language.t("session.export.error.failed"),
        description: result.error,
        variant: "error",
      })
      return
    }
    showToast({
      title: language.t("session.export.success"),
      description: result.path,
    })
  }

  type SessionDeleteTarget = Pick<Session, "id" | "directory">

  async function deleteSession(session: SessionDeleteTarget) {
    const [store, setStore] = globalSync.child(session.directory)
    const sessions = (store.session ?? []).filter((s) => !s.parentID && !s.time?.archived)
    const index = sessions.findIndex((s) => s.id === session.id)
    const nextSession = index === -1 ? undefined : (sessions[index + 1] ?? sessions[index - 1])

    const result = await globalSDK.client.session
      .delete({ directory: session.directory, sessionID: session.id })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("session.delete.failed.title"),
          description: errorMessage(err, language.t("common.requestFailed")),
          variant: "error",
        })
        return undefined
      })

    if (!result) return

    setStore(
      produce((draft) => {
        const removed = new Set<string>([session.id])
        const byParent = new Map<string, string[]>()
        for (const item of draft.session) {
          const parentID = item.parentID
          if (!parentID) continue
          const existing = byParent.get(parentID)
          if (existing) {
            existing.push(item.id)
            continue
          }
          byParent.set(parentID, [item.id])
        }
        const stack = [session.id]
        while (stack.length) {
          const parentID = stack.pop()
          if (!parentID) continue
          const children = byParent.get(parentID)
          if (!children) continue
          for (const child of children) {
            if (removed.has(child)) continue
            removed.add(child)
            stack.push(child)
          }
        }
        dropSessionCaches(draft, [...removed])
        draft.session = draft.session.filter((s) => !removed.has(s.id))
      }),
    )

    if (session.id === params.id) {
      navigate(nextSession ? `/${params.dir}/session/${nextSession.id}` : `/${params.dir}/session`)
    }
  }

  function confirmDeleteSession(session: Session) {
    const target: SessionDeleteTarget = { id: session.id, directory: session.directory }
    const name = sessionTitle(session.title) ?? language.t("command.session.new")
    dialog.show(() => (
      <DialogDeleteSession name={name} onConfirm={() => deleteSession(target)} />
    ))
  }

  function connectProvider() {
    const run = ++dialogRun
    void import("@/components/dialog-select-provider")
      .then((x) => {
        if (dialogDead || dialogRun !== run) return
        dialog.show(() => <x.DialogSelectProvider />)
      })
      .catch(() => {
        // Chunk failed to load — ignore; user can retry
      })
  }

  function openServer() {
    const run = ++dialogRun
    void import("@/components/dialog-select-server")
      .then((x) => {
        if (dialogDead || dialogRun !== run) return
        dialog.show(() => <x.DialogSelectServer />)
      })
      .catch(() => {
        // Chunk failed to load — ignore; user can retry
      })
  }

  function openSettingsSurface(tab?: SettingsTab) {
    // Guard against callers that forward a DOM event (e.g. an onClick handler)
    // as the tab argument — only a known tab string selects a page, anything
    // else falls back to General.
    setSettingsTab(typeof tab === "string" && isSettingsTab(tab) ? tab : "general")
    setActiveSurface("settings")
  }

  function toggleAutomations() {
    setActiveSurface((current) => (current === "automations" ? "none" : "automations"))
  }

  function openSettings(tab?: SettingsTab) {
    shellNavigation.openSettings(tab)
  }

  async function openGlobalConfigFolder() {
    const target = await globalSDK.client.path
      .get({ ensureConfig: true })
      .then((x) => x.data?.config)
      .catch((err) => {
        showToast({
          title: language.t("toast.settings.openGlobalConfigFolderFailed.title"),
          description: errorMessage(err, language.t("common.requestFailed")),
          variant: "error",
        })
        return undefined
      })
    if (!target) return
    await platform.openPath?.(target).catch((err) => {
      showToast({
        title: language.t("toast.settings.openGlobalConfigFolderFailed.title"),
        description: errorMessage(err, language.t("common.requestFailed")),
        variant: "error",
      })
    })
  }

  createEffect(() => {
    command.setModalOpen(activeSurface() !== "none")
  })

  function closeSettings() {
    setActiveSurface("none")
  }


  function projectRoot(directory: string) {
    const key = workspaceKey(directory)
    const project = layout.projects
      .list()
      .find(
        (item) =>
          workspaceKey(item.worktree) === key || item.sandboxes?.some((sandbox) => workspaceKey(sandbox) === key),
      )
    if (project) return project.worktree

    const known = Object.entries(store.workspaceOrder).find(
      ([root, dirs]) => workspaceKey(root) === key || dirs.some((item) => workspaceKey(item) === key),
    )
    if (known) return known[0]

    const [child] = globalSync.child(directory, { bootstrap: false })
    const id = child.project
    if (!id) return directory

    const meta = globalSync.data.project.find((item) => item.id === id)
    return meta?.worktree ?? directory
  }

  function activeProjectRoot(directory: string) {
    return currentProject()?.worktree ?? projectRoot(directory)
  }

  function releaseTransientShellLocks() {
    if (sizet !== undefined) {
      clearTimeout(sizet)
      sizet = undefined
    }
    setState("sizing", false)
  }

  function syncSessionRoute(directory: string, id: string, root = activeProjectRoot(directory)) {
    for (const key of pawworkSessionRouteUnhideKeys(directory)) {
      if (!store.pawworkProjectHidden[key]) continue
      unhideProject(key)
    }
    notification.session.markViewed(id)
    const expanded = untrack(() => store.workspaceExpanded[directory])
    if (expanded === false) {
      setStore("workspaceExpanded", directory, true)
    }
    requestAnimationFrame(() => scrollToSession(id, `${directory}:${id}`))
    return root
  }

  async function navigateToProject(directory: string | undefined) {
    if (!directory) return
    const root = projectRoot(directory)
    server.projects.touch(root)
    navigate(openProjectRoute(root))
  }

  function navigateToSession(session: Session | undefined) {
    if (session) {
      const key = projectKeyForSession(session)
      if (store.pawworkProjectHidden[key]) {
        unhideProject(key)
      }
    }
    shellNavigation.openSession(session)
  }

  function openPawworkHome(directory?: string) {
    if (directory) {
      const key = workspaceKey(directory)
      if (store.pawworkProjectHidden[key]) {
        unhideProject(key)
      }
    }
    shellNavigation.openNewSession(directory)
  }

  const shellNavigation = createShellNavigation({
    navigate,
    releaseTransientLocks: releaseTransientShellLocks,
    resolveProjectRoot: projectRoot,
    currentProjectRoot: () => currentProject()?.worktree ?? projectRoot(currentDir()),
    chooseProject,
    openSettingsSurface,
    closeSettingsSurface: closeSettings,
  })

  function openProject(directory: string, shouldNavigate = true) {
    layout.projects.open(directory)
    if (shouldNavigate) return navigateToProject(directory)
  }

  // Singleton; same instance returned every call.
  const pinned = usePinnedDraft()

  const handleDeepLinks = (urls: string[]) => {
    if (!server.isLocal()) return

    for (const directory of collectOpenProjectDeepLinks(urls)) {
      openProject(directory)
    }

    for (const link of collectNewSessionDeepLinks(urls)) {
      openProject(link.directory, false)
      const slug = base64Encode(link.directory)
      if (link.prompt) {
        // Pin the prompt to this directory so it is NOT carried portably to
        // other homepages. The pinned slot is consumed by editor-input.ts when
        // the user lands on the /repo homepage.
        pinned.adopt({ directory: link.directory, prompt: link.prompt })
        // Also keep the session handoff for the new-session composer region
        // that shows the prefill text before the session is created (T7 will
        // decide whether to clear it on submit).
        setSessionHandoff(slug, { prompt: link.prompt })
      }
      const href = `/${slug}/session`
      navigate(href)
    }
  }

  onMount(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ urls: string[] }>).detail
      const urls = detail?.urls ?? []
      if (urls.length === 0) return
      handleDeepLinks(urls)
    }

    handleDeepLinks(drainPendingDeepLinks(window))
    makeEventListener(window, deepLinkEvent, handler as EventListener)
  })

  // Run the v7 homepage-draft migration as soon as a directory becomes
  // available (fire-and-forget). currentDir() can be empty during the initial
  // autoselect phase, so onMount alone would skip migration for that session.
  // The migration writes a sentinel internally and is idempotent, so subsequent
  // effect ticks are no-ops once it has run.
  let homepageMigrationStarted = false
  createEffect(() => {
    if (homepageMigrationStarted) return
    const directory = currentDir()
    if (!directory) return
    homepageMigrationStarted = true

    const portable = usePortableDraft()
    const sentinelTarget = Persist.global(HOMEPAGE_MIGRATION_SENTINEL_KEY)
    const { read: readRaw, write: writeRaw, remove: removeRaw } = createMigrationStorageIO(platform)

    void runHomepageMigration({
      portable,
      currentDirectory: directory,
      readSentinel: async () => {
        const raw = await readRaw(sentinelTarget)
        if (!raw) return null
        try {
          return JSON.parse(raw) as import("@/components/prompt-input/homepage-migration").MigrationSentinel
        } catch {
          return null
        }
      },
      writeSentinel: async (sentinel) => {
        await writeRaw(sentinelTarget, JSON.stringify(sentinel))
      },
      loadLegacyHomepage: async (dir) => {
        const target = Persist.workspace(dir, "prompt")
        const raw = await readRaw(target)
        if (!raw) return null
        try {
          return JSON.parse(raw) as LegacyHomepagePromptStore
        } catch {
          return null
        }
      },
      clearLegacyHomepage: async (dir) => {
        // Must await: desktop removeItem is async and a rejection here must
        // propagate up to homepage-migration's failed-sentinel path. Without
        // the await, the migration would write status: "complete" even if
        // the legacy store delete failed.
        await removeRaw(Persist.workspace(dir, "prompt"))
      },
    }).catch((err) => {
      // Log diagnostic; migration retries automatically on next boot.
      console.warn("[homepage-migration] unexpected failure", err)
    })
  })

  async function renameProject(project: LocalProject, next: string) {
    const current = displayName(project)
    if (next === current) return
    const name = next === getFilename(project.worktree) ? "" : next

    if (project.id && project.id !== "global") {
      await globalSDK.client.project.update({ projectID: project.id, directory: project.worktree, name })
      return
    }

    globalSync.project.meta(project.worktree, { name })
  }

  const renameWorkspace = (directory: string, next: string, projectId?: string, branch?: string) => {
    const current = workspaceName(directory, projectId, branch) ?? branch ?? getFilename(directory)
    if (current === next) return
    setWorkspaceName(directory, next, projectId, branch)
  }

  function closeProject(directory: string) {
    const list = layout.projects.list()
    const key = workspaceKey(directory)
    const index = list.findIndex((x) => workspaceKey(x.worktree) === key)
    const active = workspaceKey(currentProject()?.worktree ?? "") === key
    if (index === -1) return
    const next = list[index + 1]

    if (!active) {
      layout.projects.close(directory)
      return
    }

    if (!next) {
      layout.projects.close(directory)
      navigate("/")
      return
    }

    navigate(`/${base64Encode(next.worktree)}/session`)
    layout.projects.close(directory)
    queueMicrotask(() => {
      void navigateToProject(next.worktree)
    })
  }

  function toggleProjectWorkspaces(project: LocalProject) {
    const enabled = layout.sidebar.workspaces(project.worktree)()
    if (enabled) {
      layout.sidebar.toggleWorkspaces(project.worktree)
      return
    }
    if (project.vcs !== "git") return
    layout.sidebar.toggleWorkspaces(project.worktree)
  }

  async function chooseProject() {
    function resolve(result: string | string[] | null) {
      if (Array.isArray(result)) {
        for (const directory of result) {
          openProject(directory, false)
        }
        navigateToProject(result[0])
      } else if (result) {
        openProject(result)
      }
    }

    if (platform.openDirectoryPickerDialog && server.isLocal()) {
      const result = await platform.openDirectoryPickerDialog?.({
        title: language.t("command.project.open"),
        multiple: true,
      })
      resolve(result)
    } else {
      const run = ++dialogRun
      void import("@/components/dialog-select-directory")
        .then((x) => {
          if (dialogDead || dialogRun !== run) return
          dialog.show(
            () => <x.DialogSelectDirectory multiple={true} onSelect={resolve} />,
            () => resolve(null),
          )
        })
        .catch(() => {
          // Chunk failed to load — resolve gracefully
          resolve(null)
        })
    }
  }

  const deleteWorkspace = async (root: string, directory: string, leaveDeletedWorkspace = false) => {
    if (directory === root) return

    const current = currentDir()
    const currentKey = workspaceKey(current)
    const deletedKey = workspaceKey(directory)
    const shouldLeave = leaveDeletedWorkspace || (!!params.dir && currentKey === deletedKey)
    if (!leaveDeletedWorkspace && shouldLeave) {
      navigate(`/${base64Encode(root)}/session`)
    }

    setBusy(directory, true)

    const result = await globalSDK.client.worktree
      .remove({ directory: root, worktreeRemoveInput: { directory } })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("workspace.delete.failed.title"),
          description: errorMessage(err, language.t("common.requestFailed")),
        })
        return false
      })

    setBusy(directory, false)

    if (!result) return

    globalSync.set(
      "project",
      produce((draft) => {
        const project = draft.find((item) => item.worktree === root)
        if (!project) return
        project.sandboxes = (project.sandboxes ?? []).filter((sandbox) => sandbox !== directory)
      }),
    )
    setStore("workspaceOrder", root, (order) => (order ?? []).filter((workspace) => workspace !== directory))

    layout.projects.close(directory)
    layout.projects.open(root)

    if (shouldLeave) return

    const nextCurrent = currentDir()
    const nextKey = workspaceKey(nextCurrent)
    const project = layout.projects.list().find((item) => item.worktree === root)
    const dirs = project
      ? effectiveWorkspaceOrder(root, [root, ...(project.sandboxes ?? [])], store.workspaceOrder[root])
      : [root]
    const valid = dirs.some((item) => workspaceKey(item) === nextKey)

    if (params.dir && projectRoot(nextCurrent) === root && !valid) {
      navigate(`/${base64Encode(root)}/session`)
    }
  }

  const resetWorkspace = async (root: string, directory: string) => {
    if (directory === root) return
    setBusy(directory, true)

    const progress = showToast({
      persistent: true,
      title: language.t("workspace.resetting.title"),
      description: language.t("workspace.resetting.description"),
    })
    const dismiss = () => toaster.dismiss(progress)

    const sessions: Session[] = await globalSDK.client.session
      .list({ directory })
      .then((x) => x.data ?? [])
      .catch(() => [])

    clearWorkspaceTerminals(
      directory,
      sessions.map((s) => s.id),
      platform,
    )
    const actionClient = globalSDK.createClient({
      headers: clientActionHeaders({ kind: "workspace.reset" }),
      throwOnError: true,
    })
    await actionClient.instance.dispose({ directory }).catch(() => undefined)

    const result = await globalSDK.client.worktree
      .reset({ directory: root, worktreeResetInput: { directory } })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("workspace.reset.failed.title"),
          description: errorMessage(err, language.t("common.requestFailed")),
        })
        return false
      })

    if (!result) {
      setBusy(directory, false)
      dismiss()
      return
    }

    const archivedAt = Date.now()
    await Promise.all(
      sessions
        .filter((session) => session.time.archived === undefined)
        .map((session) =>
          globalSDK.client.session
            .update({
              sessionID: session.id,
              directory: session.directory,
              time: { archived: archivedAt },
            })
            .catch(() => undefined),
        ),
    )

    setBusy(directory, false)
    dismiss()

    showToast({
      title: language.t("workspace.reset.success.title"),
      description: language.t("workspace.reset.success.description"),
      actions: [
        {
          label: language.t("command.session.new"),
          onClick: () => {
            const href = `/${base64Encode(directory)}/session`
            navigate(href)
          },
        },
        {
          label: language.t("common.dismiss"),
          onClick: "dismiss",
        },
      ],
    })
  }

  function DialogDeleteWorkspace(props: { root: string; directory: string }) {
    const name = createMemo(() => getFilename(props.directory))
    const [data, setData] = createStore({
      status: "loading" as "loading" | "ready" | "error",
      dirty: false,
    })

    onMount(() => {
      globalSDK.client.file
        .status({ directory: props.directory })
        .then((x) => {
          const files = x.data ?? []
          const dirty = files.length > 0
          setData({ status: "ready", dirty })
        })
        .catch(() => {
          setData({ status: "error", dirty: false })
        })
    })

    const handleDelete = () => {
      const leaveDeletedWorkspace = !!params.dir && workspaceKey(currentDir()) === workspaceKey(props.directory)
      if (leaveDeletedWorkspace) {
        navigate(`/${base64Encode(props.root)}/session`)
      }
      dialog.close()
      void deleteWorkspace(props.root, props.directory, leaveDeletedWorkspace)
    }

    const description = () => {
      if (data.status === "loading") return language.t("workspace.status.checking")
      if (data.status === "error") return language.t("workspace.status.error")
      if (!data.dirty) return language.t("workspace.status.clean")
      return language.t("workspace.status.dirty")
    }

    return (
      <Dialog title={language.t("workspace.delete.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex flex-col gap-1">
            <span class="text-body text-fg-strong">
              {language.t("workspace.delete.confirm", { name: name() })}
            </span>
            <span class="text-body text-fg-weak">{description()}</span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" disabled={data.status === "loading"} onClick={handleDelete}>
              {language.t("workspace.delete.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  function DialogResetWorkspace(props: { root: string; directory: string }) {
    const name = createMemo(() => getFilename(props.directory))
    const [state, setState] = createStore({
      status: "loading" as "loading" | "ready" | "error",
      dirty: false,
      sessions: [] as Session[],
    })

    const refresh = async () => {
      const sessions = await globalSDK.client.session
        .list({ directory: props.directory })
        .then((x) => x.data ?? [])
        .catch(() => [])
      const active = sessions.filter((session) => session.time.archived === undefined)
      setState({ sessions: active })
    }

    onMount(() => {
      globalSDK.client.file
        .status({ directory: props.directory })
        .then((x) => {
          const files = x.data ?? []
          const dirty = files.length > 0
          setState({ status: "ready", dirty })
          void refresh()
        })
        .catch(() => {
          setState({ status: "error", dirty: false })
        })
    })

    const handleReset = () => {
      dialog.close()
      void resetWorkspace(props.root, props.directory)
    }

    const archivedCount = () => state.sessions.length

    const description = () => {
      if (state.status === "loading") return language.t("workspace.status.checking")
      if (state.status === "error") return language.t("workspace.status.error")
      if (!state.dirty) return language.t("workspace.status.clean")
      return language.t("workspace.status.dirty")
    }

    const archivedLabel = () => {
      const count = archivedCount()
      if (count === 0) return language.t("workspace.reset.archived.none")
      if (count === 1) return language.t("workspace.reset.archived.one")
      return language.t("workspace.reset.archived.many", { count })
    }

    return (
      <Dialog title={language.t("workspace.reset.title")} fit>
        <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
          <div class="flex flex-col gap-1">
            <span class="text-body text-fg-strong">
              {language.t("workspace.reset.confirm", { name: name() })}
            </span>
            <span class="text-body text-fg-weak">
              {description()} {archivedLabel()} {language.t("workspace.reset.note")}
            </span>
          </div>
          <div class="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" disabled={state.status === "loading"} onClick={handleReset}>
              {language.t("workspace.reset.button")}
            </Button>
          </div>
        </div>
      </Dialog>
    )
  }

  const activeRoute = {
    session: "",
    sessionProject: "",
    directory: "",
  }

  createEffect(
    on(
      () => {
        return [pageReady(), route().slug, params.id, currentProject()?.worktree, currentDir()] as const
      },
      ([ready, slug, id, root, dir]) => {
        if (!ready || !slug || !dir) {
          activeRoute.session = ""
          activeRoute.sessionProject = ""
          activeRoute.directory = ""
          return
        }

        if (!id) {
          activeRoute.session = ""
          activeRoute.sessionProject = ""
          activeRoute.directory = ""
          return
        }

        const session = `${slug}/${id}`

        if (!root) {
          activeRoute.session = session
          activeRoute.directory = dir
          activeRoute.sessionProject = ""
          return
        }

        if (server.projects.last() !== root) server.projects.touch(root)

        const changed = session !== activeRoute.session || dir !== activeRoute.directory
        if (changed) {
          activeRoute.session = session
          activeRoute.directory = dir
          activeRoute.sessionProject = syncSessionRoute(dir, id, root)
          return
        }

        if (root === activeRoute.sessionProject) return
        activeRoute.directory = dir
        activeRoute.sessionProject = root
      },
    ),
  )

  const loadedSessionDirs = new Set<string>()

  createEffect(
    on(
      visibleSessionDirs,
      (dirs) => {
        if (dirs.length === 0) {
          loadedSessionDirs.clear()
          return
        }

        const next = new Set(dirs)
        for (const directory of next) {
          if (loadedSessionDirs.has(directory)) continue
          globalSync.project.loadSessions(directory)
        }

        loadedSessionDirs.clear()
        for (const directory of next) {
          loadedSessionDirs.add(directory)
        }
      },
      { defer: true },
    ),
  )

  function handleDragStart(event: unknown) {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeProject", id)
  }

  function handleDragOver(event: DragEvent) {
    const { draggable, droppable } = event
    if (draggable && droppable) {
      const projects = layout.projects.list()
      const fromIndex = projects.findIndex((p) => p.worktree === draggable.id.toString())
      const toIndex = projects.findIndex((p) => p.worktree === droppable.id.toString())
      if (fromIndex !== toIndex && toIndex !== -1) {
        layout.projects.move(draggable.id.toString(), toIndex)
      }
    }
  }

  function handleDragEnd() {
    setStore("activeProject", undefined)
  }

  function workspaceIds(project: LocalProject | undefined) {
    return pawworkSessionDirectories({
      project,
      activeProjectWorktree: currentProject()?.worktree,
      currentDirectory: currentDir(),
      workspaceOrder: project ? store.workspaceOrder[project.worktree] : undefined,
    })
  }

  const sidebarProject = createMemo(() => currentProject())

  function handleWorkspaceDragStart(event: unknown) {
    const id = getDraggableId(event)
    if (!id) return
    setStore("activeWorkspace", id)
  }

  function handleWorkspaceDragOver(event: DragEvent) {
    const { draggable, droppable } = event
    if (!draggable || !droppable) return

    const project = sidebarProject()
    if (!project) return

    const ids = workspaceIds(project)
    const fromIndex = ids.findIndex((dir) => dir === draggable.id.toString())
    const toIndex = ids.findIndex((dir) => dir === droppable.id.toString())
    if (fromIndex === -1 || toIndex === -1) return
    if (fromIndex === toIndex) return

    const result = ids.slice()
    const [item] = result.splice(fromIndex, 1)
    if (!item) return
    result.splice(toIndex, 0, item)
    setStore(
      "workspaceOrder",
      project.worktree,
      result.filter((directory) => workspaceKey(directory) !== workspaceKey(project.worktree)),
    )
  }

  function handleWorkspaceDragEnd() {
    setStore("activeWorkspace", undefined)
  }

  const createWorkspace = async (project: LocalProject) => {
    const created = await globalSDK.client.worktree
      .create({ directory: project.worktree })
      .then((x) => x.data)
      .catch((err) => {
        showToast({
          title: language.t("workspace.create.failed.title"),
          description: errorMessage(err, language.t("common.requestFailed")),
        })
        return undefined
      })

    if (!created?.directory) return

    setWorkspaceName(created.directory, created.branch, project.id, created.branch)

    const local = project.worktree
    const key = workspaceKey(created.directory)
    const root = workspaceKey(local)

    setBusy(created.directory, true)
    WorktreeState.pending(created.directory)
    setStore("workspaceExpanded", key, true)
    if (key !== created.directory) {
      setStore("workspaceExpanded", created.directory, true)
    }
    setStore("workspaceOrder", project.worktree, (prev) => {
      const existing = prev ?? []
      const next = existing.filter((item) => {
        const id = workspaceKey(item)
        return id !== root && id !== key
      })
      return [created.directory, ...next]
    })

    globalSync.child(created.directory)
    navigate(`/${base64Encode(created.directory)}/session`)
  }

  function createCurrentWorkspace() {
    const project = currentProject()
    if (!project) return
    return createWorkspace(project)
  }

  function toggleCurrentWorkspace() {
    const project = currentProject()
    if (!project) return undefined
    if (project.vcs !== "git") return undefined
    const wasEnabled = layout.sidebar.workspaces(project.worktree)()
    layout.sidebar.toggleWorkspaces(project.worktree)
    return wasEnabled
  }

  registerLayoutCommands({
    registry: command,
    copy: language,
    appearance: theme,
    viewActions: {
      toggleSidebar: layout.sidebar.toggle,
    },
    navigationActions: {
      openProject: chooseProject,
      moveProject: navigateProjectByOffset,
      moveSession: navigateSessionByOffset,
      moveUnseenSession: navigateSessionByUnseen,
    },
    settingsActions: {
      open: openSettings,
      canOpenGlobalConfigFolder: () => !!platform.openPath,
      openGlobalConfigFolder,
    },
    workspaceActions: {
      canCreateCurrent: () => !!workspaceSetting(),
      createCurrent: createCurrentWorkspace,
      canToggleCurrent: () => currentProject()?.vcs === "git",
      toggleCurrent: toggleCurrentWorkspace,
    },
    systemActions: {
      connectProvider,
      switchServer: openServer,
    },
  })

  const workspaceSidebarCtx: WorkspaceSidebarContext = {
    currentDir,
    navList: currentSessions,
    prefetchSession,
    openSession: navigateToSession,
    openNewSession: openPawworkHome,
    workspaceName,
    renameWorkspace,
    editorOpen,
    openEditor,
    closeEditor,
    setEditor,
    InlineEditor,
    isBusy,
    workspaceExpanded: (directory, local) => store.workspaceExpanded[directory] ?? local,
    setWorkspaceExpanded: (directory, value) => setStore("workspaceExpanded", directory, value),
    showResetWorkspaceDialog: (root, directory) =>
      dialog.show(() => <DialogResetWorkspace root={root} directory={directory} />),
    showDeleteWorkspaceDialog: (root, directory) =>
      dialog.show(() => <DialogDeleteWorkspace root={root} directory={directory} />),
    setScrollContainerRef: (el) => {
      scrollContainerRef = el
    },
  }

  const projects = () => layout.projects.list()
  const showMorePawworkSessions = () => {
    if (pawworkSessionWindowState.loading) return
    setPawworkSessionWindowState("limit", (limit) => nextPawworkSessionWindowLimit(limit))
  }
  const renderPawworkPanel = (
    sessions: Accessor<PawworkSidebarSession[]>,
    options?: { directory?: string; scope?: "main" | "peek" },
  ) => (
    <PawworkSidebar
      scope={options?.scope}
      sessions={sessions}
      sessionWindow={() => ({
        canShowMore: pawworkSessionWindow().canShowMore,
        capReached: pawworkSessionWindow().capReached,
        loading: pawworkSessionWindowState.loading,
      })}
      showProjectEmptyState={projects().length === 0}
      activeSessionID={() => params.id}
      pinnedIDs={() => store.pawworkPinnedSessions}
      sortMode={() => store.pawworkSortMode}
      collapsedProjects={() => store.pawworkProjectCollapsed}
      onToggleProjectCollapsed={toggleProjectCollapsed}
      setScrollContainerRef={workspaceSidebarCtx.setScrollContainerRef}
      prefetchSession={prefetchSession}
      onOpenSession={navigateToSession}
      onRenameSession={renamePawworkSession}
      onRenameProject={handleRenameProject}
      onRemoveProject={hideProject}
      onTogglePinnedSession={togglePinnedSession}
      onDragSession={dragPawworkSession}
      onMovePinnedSession={movePinnedSessionByOne}
      exportSessionAvailable={exportSessionAvailable}
      onExportSession={exportSession}
      onDeleteSession={confirmDeleteSession}
      onSetSortMode={setPawworkSortMode}
      onShowMore={showMorePawworkSessions}
      onSearchOlderSessions={() => command.show()}
      onNew={() => openPawworkHome(options?.directory)}
      onSearch={() => command.show()}
      onOpenProject={chooseProject}
      onOpenAutomations={toggleAutomations}
      automationsActive={automationsOpen}
      automationsLabel={() => language.t("sidebar.pawwork.automations")}
      onOpenSettings={() => openSettings()}
      settingsLabel={() => language.t("sidebar.settings")}
      settingsKeybind={() => command.keybind("settings.open")}
      newSessionKeybind={() => command.keybind("session.new")}
      searchKeybind={() => command.keybind("command.palette")}
    />
  )
  const sidebarContent = () =>
    renderPawworkPanel(pawworkSessions, { directory: currentProject()?.worktree, scope: "main" })

  function handleSidebarResize(width: number) {
    setState("sizing", true)
    if (sizet !== undefined) clearTimeout(sizet)
    sizet = window.setTimeout(() => setState("sizing", false), 120)
    layout.sidebar.resize(width)
  }

  return (
    <LayoutPageContext.Provider
      value={{
        pinnedIDs: () => store.pawworkPinnedSessions,
        workspaceOrderFor: (worktree: string) => store.workspaceOrder[worktree],
        openProject: () => {
          void chooseProject()
        },
      }}
    >
      <ShellSurfaceContext.Provider
        value={{
          settingsOpen,
          openNewSession: openPawworkHome,
          openSession: navigateToSession,
          openSettings,
          closeSettings,
        }}
      >
        <LayoutShellFrame
          platform={platform}
          sizing={() => state.sizing}
          sidebar={{
            visible: () => layout.sidebar.opened() || settingsOpen(),
            width: layout.sidebar.width,
            minWidth: 180,
            maxWidth: () => (typeof window === "undefined" ? 1000 : window.innerWidth * 0.3 + 64),
            label: () => language.t("sidebar.nav.projectsAndSessions"),
            content: sidebarContent,
            onResizeStart: () => setState("sizing", true),
            onResize: handleSidebarResize,
          }}
          rightPanel={{
            opened: layout.rightPanel.opened,
            width: layout.rightPanel.width,
          }}
          settings={{
            open: settingsOpen,
            title: () => language.t("sidebar.settings"),
            nav: () => <SettingsNav active={settingsTab()} onSelect={setSettingsTab} onClose={closeSettings} />,
            content: () => <SettingsContent active={settingsTab()} directory={currentDir()} onClose={closeSettings} />,
          }}
          automations={{
            open: automationsOpen,
            title: () => language.t("automations.title"),
            content: () => (
              <AutomationsSurface
                directory={() => currentProject()?.worktree ?? projectRoot(currentDir())}
                onClose={closeSettings}
              />
            ),
          }}
          main={() => (
            <Show when={!startupAutoselectPending()} fallback={<AppStartupPending />}>
              {props.children}
            </Show>
          )}
        />
      </ShellSurfaceContext.Provider>
    </LayoutPageContext.Provider>
  )
}
