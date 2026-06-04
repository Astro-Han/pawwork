import { batch, createEffect, createMemo, on, onCleanup } from "solid-js"
import { createStore, reconcile, type SetStoreFunction } from "solid-js/store"
import type { GlobalSession, Session } from "@opencode-ai/sdk/v2/client"
import { base64Encode } from "@opencode-ai/util/encode"
import { showToast } from "@opencode-ai/ui/toast"
import type { useGlobalSDK } from "@/context/global-sdk"
import type { useGlobalSync } from "@/context/global-sync"
import { isTerminalGoneError } from "@/context/terminal"
import type { LocalProject } from "@/context/layout"
import { errorMessage } from "./helpers"
import {
  buildPawworkSessionWindow,
  nextPawworkSessionWindowLimit,
  PAWWORK_SESSION_WINDOW_INITIAL,
  pawworkSessionWindowActiveRoot,
  sortPawworkSessionWindowSessions,
  type PawworkWindowSession,
} from "./pawwork-session-window"
import {
  buildPawworkSidebarSessionRows,
  resolvePawworkSessionProjectKey,
  resolvePawworkSessionProjectLabel,
  sortPawworkSidebarSessions,
} from "./pawwork-session-source"
import { buildPawworkSessionSections, flattenPawworkSessionSections } from "./pawwork-session-nav"
import { createDefaultLayoutPageState, removePinnedSessionIDs } from "./layout-page-store"

type LayoutPageState = ReturnType<typeof createDefaultLayoutPageState>

export type PawworkSessionControllerInput = {
  pageReady: () => boolean
  layoutReady: () => boolean
  params: { readonly id?: string }
  visibleSessionDirs: () => string[]
  projects: () => LocalProject[]
  directStartDirectory: () => string | undefined
  workspaceName: (directory: string, projectId?: string, branch?: string) => string | undefined
  store: LayoutPageState
  setStore: SetStoreFunction<LayoutPageState>
  globalSDK: Pick<ReturnType<typeof useGlobalSDK>, "client" | "url" | "event">
  globalSync: Pick<ReturnType<typeof useGlobalSync>, "ready" | "child" | "peekExisting">
  language: { t: (key: string, params?: Record<string, string | number | boolean>) => string }
}

export function createPawworkSessionController(input: PawworkSessionControllerInput) {
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
    for (const directory of input.visibleSessionDirs()) {
      const [dirStore] = input.globalSync.child(directory, { bootstrap: false })
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
      const response = await input.globalSDK.client.session.get({ sessionID })
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
    return resolvePawworkSessionProjectKey(session, { directStartDirectory: input.directStartDirectory() })
  }

  const projectLabelForSession = (session: Session | GlobalSession) => {
    return resolvePawworkSessionProjectLabel(session, {
      projects: input.projects(),
      directStartDirectory: input.directStartDirectory(),
      directStartLabel: input.language.t("sidebar.pawwork.directStart"),
      workspaceName: input.workspaceName,
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
        const tuple = input.globalSync.peekExisting(session.directory)
        return tuple?.[0].message[session.id]
      },
      partsForMessage: (session, messageID) => {
        const tuple = input.globalSync.peekExisting(session.directory)
        return tuple?.[0].part[messageID]
      },
    })
    const hidden = input.store.pawworkProjectHidden
    const filtered = rows.filter((row) => !hidden[row.projectKey])
    return sortPawworkSidebarSessions(filtered.map((item) => ({ ...item, id: item.session.id }))).map(
      ({ id: _, ...item }) => item,
    )
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
      pinnedIDs: input.store.pawworkPinnedSessions,
      sortMode: input.store.pawworkSortMode,
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
    if (!input.pageReady()) return
    if (!input.layoutReady()) return
    if (!input.globalSync.ready) return
    const rev = ++pawworkSessionWindowRev
    setPawworkSessionWindowState("loading", true)
    try {
      const response = await input.globalSDK.client.experimental.session.list({
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
        input.store.pawworkPinnedSessions.map(async (id) => ({
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
      const activeID = input.params.id
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
          input.setStore("pawworkPinnedSessions", (current) => removePinnedSessionIDs(current, gonePinnedIDs))
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
        title: input.language.t("toast.session.listFailed.title", { project: "PawWork" }),
        description: errorMessage(error, input.language.t("common.requestFailed")),
      })
    }
  }

  createEffect(
    on(
      () => [
        input.pageReady(),
        input.layoutReady(),
        input.globalSync.ready,
        input.globalSDK.url,
        pawworkSessionWindowState.limit,
        input.store.pawworkPinnedSessions.join("\0"),
        input.params.id,
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
      if (input.store.pawworkPinnedSessions.includes(info.id)) {
        setPawworkSessionWindowState("pinned", mergeWindowSession)
      }
      if (input.params.id === info.id) {
        setPawworkSessionWindowState("active", (current) =>
          current?.id === info.id ? mergePawworkWindowSessionMetadata(info, current) : mergePawworkWindowSessionMetadata(info),
        )
      }
    })
  }

  const removePawworkWindowSession = (sessionID: string) => {
    input.setStore("pawworkPinnedSessions", (current) => removePinnedSessionIDs(current, new Set([sessionID])))
    setPawworkSessionWindowState("normal", (current) => current.filter((session) => session.id !== sessionID))
    setPawworkSessionWindowState("pinned", (current) => current.filter((session) => session.id !== sessionID))
    if (pawworkSessionWindowState.active?.id === sessionID) {
      setPawworkSessionWindowState("active", undefined)
    }
  }

  onCleanup(
    input.globalSDK.event.listen((event) => {
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

  const showMore = () => {
    if (pawworkSessionWindowState.loading) return
    setPawworkSessionWindowState("limit", (limit) => nextPawworkSessionWindowLimit(limit))
  }

  const windowLoading = () => pawworkSessionWindowState.loading

  return {
    sessionWindow: pawworkSessionWindow,
    sessions: pawworkSessions,
    sessionSections: pawworkSessionSections,
    sessionByID: pawworkSessionByID,
    loadSessionByID,
    navigationSessions: pawworkNavigationSessions,
    projectKeyForSession,
    windowLoading,
    showMore,
  }
}
