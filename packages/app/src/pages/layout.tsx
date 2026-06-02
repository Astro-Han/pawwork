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
import { getFilename } from "@opencode-ai/util/path"
import { Session } from "@opencode-ai/sdk/v2/client"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { createStore, produce } from "solid-js/store"
import type { DragEvent } from "@thisbeyond/solid-dnd"
import { useProviders } from "@/hooks/use-providers"
import { showToast } from "@opencode-ai/ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { LayoutPageContext } from "@/context/layout-page"
import { ShellSurfaceContext } from "@/context/shell-surface"
import { clearWorkspaceTerminals } from "@/context/terminal"
import { dropSessionCaches } from "@/context/global-sync/session-cache"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { Binary } from "@opencode-ai/util/binary"
import { playSoundById } from "@/utils/sound"
import { setNavigate } from "@/utils/notification-click"
import { setOpenSettings } from "@/utils/settings-navigation"
import { Worktree as WorktreeState } from "@/utils/worktree"
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
  errorMessage,
  startupAutoselectDirectory,
  sortedRootSessions,
  workspaceKey,
} from "./layout/helpers"
import { createInlineEditorController } from "./layout/inline-editor"
import { pawworkSessionDirectories } from "./layout/pawwork-session-source"
import { findPawworkSessionNavigationTarget } from "./layout/pawwork-session-nav"
import { createShellNavigation } from "./layout/shell-navigation"
import { useUpdatePolling } from "./layout/layout-update-polling"
import { sessionNotificationHref, useSDKNotificationToasts } from "./layout/layout-sdk-event-effects"
import { registerLayoutCommands } from "./layout/layout-commands"
import { LayoutShellFrame } from "./layout/layout-shell-frame"
import { createPawworkSessionPrefetch } from "./layout/pawwork-session-prefetch"
import { createPawworkSessionController } from "./layout/pawwork-session-controller"
import { createPawworkProjectControls } from "./layout/pawwork-project-controls"
import { createPawworkRoutingActions } from "./layout/pawwork-routing-actions"
import { createPawworkWorkspaceLifecycle } from "./layout/pawwork-workspace-lifecycle"
import { createWorkspaceDialogs } from "./layout/pawwork-workspace-dialogs"
import { type WorkspaceSidebarContext } from "./layout/sidebar-workspace"
import { PawworkSidebar, type PawworkSidebarSession } from "./layout/pawwork-sidebar"
import { createDefaultLayoutPageState, createLayoutPagePersistTarget } from "./layout/layout-page-store"
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
  const [settingsOpen, setSettingsOpen] = createSignal(false)
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

  const {
    sessionWindow: pawworkSessionWindow,
    sessions: pawworkSessions,
    sessionSections: pawworkSessionSections,
    sessionByID: pawworkSessionByID,
    navigationSessions: pawworkNavigationSessions,
    projectKeyForSession,
    windowLoading: pawworkSessionWindowLoading,
    showMore: showMorePawworkSessions,
  } = createPawworkSessionController({
    pageReady,
    layoutReady,
    params,
    visibleSessionDirs,
    projects: () => layout.projects.list(),
    workspaceName,
    store,
    setStore,
    globalSDK,
    globalSync,
    language,
  })

  const { prefetchSession, warm } = createPawworkSessionPrefetch({
    params,
    route,
    currentDir,
    visibleSessionDirs,
    navigationSessions: pawworkNavigationSessions,
    globalSDK,
    globalSync,
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

  const {
    togglePinnedSession,
    dragPawworkSession,
    movePinnedSessionByOne,
    setPawworkSortMode,
    toggleProjectCollapsed,
    hideProject,
    unhideProject,
    handleRenameProject,
    expandPawworkProjectGroup,
  } = createPawworkProjectControls({
    store,
    setStore,
    language,
    projects: () => layout.projects.list(),
    sessions: () => pawworkSessionWindow().sessions,
    renameProject,
    setWorkspaceName,
  })

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
    setSettingsOpen(true)
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
    command.setModalOpen(settingsOpen())
  })

  function closeSettings() {
    setSettingsOpen(false)
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

  const shellNavigation = createShellNavigation({
    navigate,
    releaseTransientLocks: releaseTransientShellLocks,
    resolveProjectRoot: projectRoot,
    currentProjectRoot: () => currentProject()?.worktree ?? projectRoot(currentDir()),
    chooseProject,
    openSettingsSurface,
    closeSettingsSurface: closeSettings,
  })

  // Singleton; same instance returned every call.
  const pinned = usePinnedDraft()

  const {
    syncSessionRoute,
    navigateToProject,
    navigateToSession,
    openPawworkHome,
    openProject,
  } = createPawworkRoutingActions({
    navigate,
    server,
    store,
    setStore,
    notification,
    scrollToSession,
    pinned,
    projectRoot,
    activeProjectRoot,
    shellNavigation,
    unhideProject,
    projectKeyForSession,
    layout,
  })

  const {
    renameWorkspace,
    deleteWorkspace,
    resetWorkspace,
    createWorkspace,
    createCurrentWorkspace,
    toggleCurrentWorkspace,
  } = createPawworkWorkspaceLifecycle({
    globalSDK,
    globalSync,
    layout,
    platform,
    clearWorkspaceTerminals,
    store,
    setStore,
    navigate,
    language,
    params,
    setBusy,
    currentDir,
    currentProject,
    projectRoot,
    setWorkspaceName,
    workspaceName,
  })

  const { DialogDeleteWorkspace, DialogResetWorkspace } = createWorkspaceDialogs({
    globalSDK,
    dialog,
    language,
    params,
    currentDir,
    navigate,
    deleteWorkspace,
    resetWorkspace,
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
        loading: pawworkSessionWindowLoading(),
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
