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
import { useProviders } from "@/hooks/use-providers"
import { showToast } from "@opencode-ai/ui/toast"
import { useGlobalSDK } from "@/context/global-sdk"
import { LayoutPageContext } from "@/context/layout-page"
import { clearWorkspaceTerminals } from "@/context/terminal"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { playSoundById } from "@/utils/sound"
import { setNavigate } from "@/utils/notification-click"
import { setOpenSettings } from "@/utils/settings-navigation"
import { setOpenAutomations } from "@/utils/automations-navigation"
import { Worktree as WorktreeState } from "@/utils/worktree"
import { usePinnedDraft } from "@/components/prompt-input/pinned-draft"

import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useTheme } from "@opencode-ai/ui/theme/context"
import { useCommand } from "@/context/command"
import { useServer } from "@/context/server"
import { useLanguage } from "@/context/language"
import {
  displayName,
  startupAutoselectDirectory,
  sortedRootSessions,
  workspaceKey,
} from "./layout/helpers"
import { createInlineEditorController } from "./layout/inline-editor"
import { createPawworkSessionCommands, type SessionDeleteTarget } from "./layout/pawwork-session-commands"
import { pawworkSessionDirectories } from "./layout/pawwork-session-source"
import { findPawworkSessionNavigationTarget } from "./layout/pawwork-session-nav"
import { createShellNavigation } from "./layout/shell-navigation"
import {
  SURFACE_ROUTE_PATHS,
  parseSessionRoutePath,
  readSurfaceRouteState,
  resolveSurfaceClose,
  surfaceEntryState,
  surfaceRouteName,
  type SurfaceRouteName,
} from "./layout/surface-routes"
import { SurfacePageContext } from "./layout/surface-page-context"
import { useUpdatePolling } from "./layout/layout-update-polling"
import { useHomepageMigration } from "./layout/layout-homepage-migration"
import { createOpenGlobalConfigFolder } from "./layout/layout-open-global-config"
import { createCurrentProjectMemo } from "./layout/layout-current-project"
import { createNavigateProjectByOffset } from "./layout/layout-navigate-project"
import { sessionNotificationHref, useSDKNotificationToasts } from "./layout/layout-sdk-event-effects"
import { registerLayoutCommands } from "./layout/layout-commands"
import { LayoutShellFrame } from "./layout/layout-shell-frame"
import { createPawworkSessionPrefetch } from "./layout/pawwork-session-prefetch"
import { createPawworkSessionController } from "./layout/pawwork-session-controller"
import { createPawworkProjectControls } from "./layout/pawwork-project-controls"
import { createPawworkRoutingActions } from "./layout/pawwork-routing-actions"
import { createPawworkWorkspaceLifecycle } from "./layout/pawwork-workspace-lifecycle"
import { createPawworkWorkspaceDialogs } from "./layout/pawwork-workspace-dialogs"
import { type WorkspaceSidebarContext } from "./layout/sidebar-workspace"
import { PawworkSidebar, type PawworkSidebarSession } from "./layout/pawwork-sidebar"
import { createDefaultLayoutPageState, createLayoutPagePersistTarget } from "./layout/layout-page-store"
import { SettingsNav, isSettingsTab, type SettingsTab } from "@/pages/settings/settings-shell"
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
  const [settingsTab, setSettingsTab] = createSignal<SettingsTab>("general")

  const params = useParams()
  const location = useLocation()
  // The three shell surfaces are real top-level routes; everything that used
  // to read a takeover signal derives from the route instead.
  const surfaceRoute = createMemo(() => surfaceRouteName(location.pathname))
  const settingsOpen = createMemo(() => surfaceRoute() === "settings")
  const automationsOpen = createMemo(() => surfaceRoute() === "automations")
  const skillsOpen = createMemo(() => surfaceRoute() === "skills")
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
  // Non-shell entry points (notification clicks, deep links dispatched
  // through @/utils/notification-click) navigate directly; the surfaces are
  // routes, so navigating to a session leaves them naturally.
  setNavigate(navigate)
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
  // Last directory a /:dir route was visited in. Global surfaces (settings /
  // automations / skills) and the command palette read activeDirectory for
  // directory context when no project route is active. The trailing fallbacks
  // mirror HomeRedirectRoute: first open project, then first synced project.
  const [lastRouteDir, setLastRouteDir] = createSignal("")
  createEffect(() => {
    const dir = currentDir()
    if (dir) setLastRouteDir(dir)
  })
  const activeDirectory = createMemo(
    () =>
      currentDir() ||
      lastRouteDir() ||
      layout.projects.list()[0]?.worktree ||
      (globalSync.ready ? (globalSync.data.project[0]?.worktree ?? "") : ""),
  )
  const pawworkSidebar = createMemo(() => globalSync.data.project.length <= 1)

  const [state, setState] = createStore({
    // Booting on a surface route (e.g. a web reload on /settings) is a real
    // destination, not a "no project yet" start — autoselect must not yank
    // the user off it.
    autoselect: !initialDirectory && !surfaceRoute(),
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
      requestAttention: () => platform.requestAttention?.(),
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

  // Keyed on activeDirectory, not the raw route directory: the sidebar and
  // project-scoped chrome stay on the last visited project while a global
  // surface route (/settings /automations /skills) is mounted.
  const currentProject = createCurrentProjectMemo({ currentDir: activeDirectory, layout, globalSync })
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

    const activeDir = activeDirectory()
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
    loadSessionByID,
    navigationSessions: pawworkNavigationSessions,
    windowLoading: pawworkSessionWindowLoading,
    showMore: showMorePawworkSessions,
  } = createPawworkSessionController({
    pageReady,
    layoutReady,
    params,
    visibleSessionDirs,
    projects: () => layout.projects.list(),
    directStartDirectory: () => globalSync.data.path.directory,
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

  const {
    togglePinnedSession,
    dragPawworkSession,
    movePinnedSessionByOne,
    setPawworkSortMode,
    toggleProjectCollapsed,
    handleRenameProject,
    expandPawworkProjectGroup,
  } = createPawworkProjectControls({
    store,
    setStore,
    projects: () => layout.projects.list(),
    sessions: () => pawworkSessionWindow().sessions,
    renameProject,
    setWorkspaceName,
  })

  const { exportSessionAvailable, renamePawworkSession, exportSession, deleteSession } = createPawworkSessionCommands({
    globalSDK,
    globalSync,
    platform,
    server,
    language,
    navigate,
    params,
  })

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

  // Enter a surface route, recording the current location as the origin in
  // the navigation's own history-entry state. Re-activating the surface the
  // user is already on is a no-op; a deep-entry request (one automation)
  // updates the current entry's state in place, preserving its origin.
  function openSurface(name: SurfaceRouteName, extras?: { automationID?: string }) {
    const target = SURFACE_ROUTE_PATHS[name]
    if (location.pathname === target) {
      if (extras?.automationID) {
        navigate(target, {
          replace: true,
          state: { ...readSurfaceRouteState(location.state), automationID: extras.automationID },
        })
      }
      return
    }
    navigate(target, { state: surfaceEntryState({ location, automationID: extras?.automationID }) })
  }

  // Close returns to the recorded origin. A session origin deleted while away
  // falls through to the active directory's session home, then the home
  // redirect. Surface-route origins (the previous hop of a chain) are always
  // honored, unwinding one close at a time.
  function closeSurface() {
    const close = resolveSurfaceClose({
      state: location.state,
      validateOrigin: (origin) => {
        const parsed = parseSessionRoutePath(origin.pathname)
        if (!parsed?.sessionID) return true
        const directory = decode64(parsed.slug)
        if (!directory) return false
        const [child] = globalSync.child(directory, { bootstrap: false })
        // Only a fully bootstrapped child can prove the origin stale: before
        // that, its session list just hasn't loaded. This also covers the
        // origin being the directory's ONLY session, deleted while away — the
        // loaded list is then legitimately empty, which a bare length check
        // could not tell apart from "not loaded yet".
        if (child.status !== "complete") return true
        return (child.session ?? []).some((session) => session.id === parsed.sessionID)
      },
      fallback: (() => {
        const directory = activeDirectory()
        return directory ? `/${base64Encode(directory)}/session` : "/"
      })(),
    })
    navigate(close.href, { state: close.state })
  }

  function openSettingsSurface(tab?: SettingsTab) {
    // Guard against callers that forward a DOM event (e.g. an onClick handler)
    // as the tab argument — only a known tab string selects a page, anything
    // else falls back to General.
    setSettingsTab(typeof tab === "string" && isSettingsTab(tab) ? tab : "general")
    openSurface("settings")
  }

  function openAutomationsSurface() {
    openSurface("automations")
  }

  function openSkillsSurface() {
    openSurface("skills")
  }

  // Open the Automations page focused on one automation. Wired to the
  // module-level bridge so the automate tool card (deep in the message thread,
  // outside this shell) can jump here. The route component reads the request
  // from the navigation state.
  function openAutomationByID(automationID?: string) {
    openSurface("automations", { automationID })
  }
  setOpenAutomations(openAutomationByID)

  // The project root surfaces act on: the active project, resolved through
  // the last visited directory when no /:dir route is mounted.
  const surfaceProjectRoot = () => currentProject()?.worktree ?? projectRoot(activeDirectory())

  // "Create via chat" leaves the page and starts a fresh session in the current
  // project, prefilled with a short guiding prompt the user can edit or send.
  // The ?prompt= bootstrap (see useSessionRoutePromptBootstrap) seeds the
  // composer reactively, so it works whether or not we are already on the
  // new-session route.
  function createAutomationViaChat() {
    const directory = surfaceProjectRoot()
    if (!directory) return
    const prompt = encodeURIComponent(language.t("automations.create.viaChatPrompt"))
    navigate(`/${base64Encode(directory)}/session?prompt=${prompt}`)
  }

  // Skills resolve per active directory (not the project root the Automations
  // page uses), exactly like the composer's slash picker: activeDirectory
  // keeps the workspace/sandbox the user was in, so the gallery and "Use in
  // chat" match the skills the composer would actually offer. Skills are
  // directory-resolved, not project entities.

  // "Use in chat" from the Skills gallery leaves the page and starts a fresh
  // session in the active directory. The ?skill= bootstrap seeds the composer with
  // the structured skill chip, so the picked skill activates deterministically.
  function useSkillInChat(name: string) {
    const directory = activeDirectory()
    if (!directory) return
    navigate(`/${base64Encode(directory)}/session?skill=${encodeURIComponent(name)}`)
  }

  function openSettings(tab?: SettingsTab) {
    shellNavigation.openSettings(tab)
  }

  const openGlobalConfigFolder = createOpenGlobalConfigFolder({ globalSDK, platform, language })

  // Opening a run from the Automations page lands on the run's chat session,
  // which also lives in the normal All chats list.
  async function openAutomationRun(sessionID: string) {
    const session = await loadSessionByID(sessionID)
    if (session) navigateToSession(session)
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
    // activeDirectory equals currentDir on /:dir routes; elsewhere it falls
    // back to the last visited directory so shell navigation (e.g. "new
    // session" from a global page) still resolves a project.
    currentProjectRoot: surfaceProjectRoot,
    directStartRoot: () => globalSync.data.path.directory,
    chooseProject,
    openSettingsSurface,
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
    layout,
  })

  const navigateProjectByOffset = createNavigateProjectByOffset({
    layout,
    currentProject,
    currentDir,
    projectRoot,
    globalSync,
    openProject,
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

  const { DialogDeleteWorkspace, DialogResetWorkspace } = createPawworkWorkspaceDialogs({
    globalSDK,
    dialog,
    language,
    params,
    currentDir,
    navigate,
    deleteWorkspace,
    resetWorkspace,
  })

  useHomepageMigration({ currentDir, platform })

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

  // Sidebar "Remove project" closes the working directory from the single source
  // of truth (`server.projects`), so it disappears from the sidebar, the
  // workspace chip, and survives new sessions. The group key may be a subfolder
  // or sandbox, so resolve it to the open project root before closing; undo
  // simply reopens it.
  function removeProject(projectKey: string) {
    const root = projectRoot(projectKey)
    const entry = layout.projects.list().find((x) => workspaceKey(x.worktree) === workspaceKey(root))
    if (!entry) return
    const worktree = entry.worktree
    // closeProject navigates away when the removed project is the active one, so
    // Undo has to restore focus there too — a bare reopen would leave the user
    // wherever the close sent them.
    const wasActive = workspaceKey(currentProject()?.worktree ?? "") === workspaceKey(worktree)
    closeProject(worktree)
    showToast({
      title: language.t("project.remove.toast.title"),
      description: language.t("project.remove.toast.description"),
      actions: [
        {
          label: language.t("common.undo"),
          onClick: () => (wasActive ? openProject(worktree, true) : layout.projects.open(worktree)),
        },
      ],
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

  function workspaceIds(project: LocalProject | undefined) {
    return pawworkSessionDirectories({
      project,
      activeProjectWorktree: currentProject()?.worktree,
      currentDirectory: activeDirectory(),
      workspaceOrder: project ? store.workspaceOrder[project.worktree] : undefined,
    })
  }

  // dialog.show renders the dialog under this body's owner, which sits above
  // the LayoutPageContext.Provider in the JSX below — so the palette element
  // wraps the provider explicitly instead of relying on the owner chain.
  const layoutPageValue = {
    pinnedIDs: () => store.pawworkPinnedSessions,
    workspaceOrderFor: (worktree: string) => store.workspaceOrder[worktree],
    openProject: () => {
      void chooseProject()
    },
    activeDirectory,
  }

  function openCommandPalette(source?: "palette" | "keybind" | "slash") {
    const run = ++dialogRun
    void import("@/components/dialog-select-file")
      .then((x) => {
        if (dialogDead || dialogRun !== run) return
        dialog.show(() => (
          <LayoutPageContext.Provider value={layoutPageValue}>
            <x.DialogSelectFile mode={source === "slash" ? "files" : undefined} />
          </LayoutPageContext.Provider>
        ))
      })
      .catch(() => {
        // Chunk failed to load — ignore; user can retry
      })
  }

  function openNewSessionCommand() {
    // On a /:dir route, preserve the previous session-page behavior exactly:
    // stay in the current route directory (a workspace keeps its own home).
    // Elsewhere, resolve through the shell (active project, else picker).
    const slug = params.dir
    if (slug) {
      navigate(`/${slug}/session`)
      return
    }
    openPawworkHome()
  }

  registerLayoutCommands({
    registry: command,
    copy: language,
    appearance: theme,
    viewActions: {
      toggleSidebar: layout.sidebar.toggle,
    },
    paletteActions: {
      open: openCommandPalette,
      canOpenFiles: () => !!activeDirectory(),
    },
    sessionActions: {
      openNew: openNewSessionCommand,
    },
    navigationActions: {
      openProject: chooseProject,
      moveProject: navigateProjectByOffset,
      moveSession: navigateSessionByOffset,
      moveUnseenSession: navigateSessionByUnseen,
      // Session-relative navigation has no anchor on a surface route
      // (params.id is gone) — it would jump to an arbitrary session, yanking
      // the user off the page they deliberately opened.
      canMoveSession: () => !surfaceRoute(),
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
      // Intentionally keyed on open projects only: with zero projects we show
      // the "open a project" empty state even if direct-start rows survive the
      // session filter. The sidebar lists only open projects; direct-start
      // sessions stay reachable once any project is open (or by reopening).
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
      onRemoveProject={removeProject}
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
      // The palette dialog mounts directory-bound providers; with zero
      // projects there is nothing to search, so the button shows as disabled.
      searchAvailable={() => !!activeDirectory()}
      onOpenProject={chooseProject}
      onOpenSkills={openSkillsSurface}
      skillsActive={skillsOpen}
      skillsLabel={() => language.t("sidebar.pawwork.skills")}
      onOpenAutomations={openAutomationsSurface}
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
    <LayoutPageContext.Provider value={layoutPageValue}>
      <SurfacePageContext.Provider
        value={{
          close: closeSurface,
          settings: {
            tab: settingsTab,
            directory: activeDirectory,
          },
          automations: {
            directory: surfaceProjectRoot,
            projectID: () => currentProject()?.id,
            openRun: (sessionID) => {
              void openAutomationRun(sessionID)
            },
            createViaChat: createAutomationViaChat,
          },
          skills: {
            directory: activeDirectory,
            useInChat: useSkillInChat,
          },
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
            nav: () => <SettingsNav active={settingsTab()} onSelect={setSettingsTab} onClose={closeSurface} />,
          }}
          automations={{
            open: automationsOpen,
            title: () => language.t("automations.title"),
          }}
          skills={{
            open: skillsOpen,
            title: () => language.t("skills.title"),
          }}
          main={() => (
            <Show when={!startupAutoselectPending()} fallback={<AppStartupPending />}>
              {props.children}
            </Show>
          )}
        />
      </SurfacePageContext.Provider>
    </LayoutPageContext.Provider>
  )
}
