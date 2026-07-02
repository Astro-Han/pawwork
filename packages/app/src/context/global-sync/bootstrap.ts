import { Binary } from "@opencode-ai/util/binary"
import type {
  Config,
  Message,
  OpencodeClient,
  Part,
  Path,
  PermissionRequest,
  Project,
  ProviderListResponse,
  Session,
} from "@opencode-ai/sdk/v2/client"
import { showToast } from "@opencode-ai/ui/toast"
import { getFilename } from "@opencode-ai/util/path"
import { retry } from "@opencode-ai/util/retry"
import { batch } from "solid-js"
import { produce, reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import type { State, VcsCache } from "./types"
import { mergeAutomationList } from "./automation-store"
import { pendingExternalResultQuestionFromPart, type PendingExternalResultQuestion } from "./external-result-question"
import { cmp, normalizeAgentList, normalizeProviderList } from "./utils"
import { formatServerError } from "@/utils/server-errors"
import { QueryClient, queryOptions } from "@tanstack/solid-query"
import { loadSessionsQuery, type GlobalStore } from "../global-sync"

function waitForPaint() {
  return new Promise<void>((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    const timer = setTimeout(finish, 50)
    if (typeof requestAnimationFrame !== "function") return
    requestAnimationFrame(() => {
      setTimeout(() => {
        clearTimeout(timer)
        finish()
      }, 0)
    })
  })
}

function errors(list: PromiseSettledResult<unknown>[]) {
  return list.filter((item): item is PromiseRejectedResult => item.status === "rejected").map((item) => item.reason)
}

function isNotFoundError(error: unknown) {
  if (!error || typeof error !== "object") return false
  const value = error as { name?: unknown; status?: unknown; statusCode?: unknown; response?: { status?: unknown } }
  if (value.name === "NotFoundError") return true
  if (value.status === 404 || value.statusCode === 404) return true
  return value.response?.status === 404
}

const providerRev = new Map<string, number>()

export function clearProviderRev(directory: string) {
  providerRev.delete(directory)
}

function runAll(list: Array<() => Promise<unknown>>) {
  return Promise.allSettled(list.map((item) => item()))
}

export async function bootstrapGlobal(input: {
  globalSDK: OpencodeClient
  requestFailedTitle: string
  translate: (key: string, vars?: Record<string, string | number>) => string
  formatMoreCount: (count: number) => string
  setGlobalStore: SetStoreFunction<GlobalStore>
  queryClient: QueryClient
}) {
  const fast = [
    () =>
      retry(() =>
        input.globalSDK.global.config.get().then((x) => {
          input.setGlobalStore("config", x.data!)
        }),
      ),
    () =>
      input.queryClient.fetchQuery({
        ...loadProvidersQuery(null),
        queryFn: () =>
          retry(() =>
            input.globalSDK.provider.list().then((x) => {
              input.setGlobalStore("provider", normalizeProviderList(x.data!))
              return null
            }),
          ),
      }),
  ]

  const slow = [
    () =>
      retry(() =>
        input.globalSDK.path.get().then((x) => {
          input.setGlobalStore("path", x.data!)
        }),
      ),
    () =>
      retry(() =>
        input.globalSDK.project.list().then((x) => {
          const projects = (x.data ?? [])
            .filter((p) => !!p?.id)
            .filter((p) => !!p.worktree && !p.worktree.includes("opencode-test"))
            .slice()
            .sort((a, b) => cmp(a.id, b.id))
          input.setGlobalStore("project", projects)
        }),
      ),
  ]
  await runAll(fast)
  // showErrors({
  //   errors: errors(await runAll(fast)),
  //   title: input.requestFailedTitle,
  //   translate: input.translate,
  //   formatMoreCount: input.formatMoreCount,
  // })
  await waitForPaint()
  await runAll(slow)
  // showErrors({
  //   errors: errors(),
  //   title: input.requestFailedTitle,
  //   translate: input.translate,
  //   formatMoreCount: input.formatMoreCount,
  // })
  input.setGlobalStore("ready", true)
}

function groupBySession<T extends { id: string; sessionID: string }>(input: T[]) {
  return input.reduce<Record<string, T[]>>((acc, item) => {
    if (!item?.id || !item.sessionID) return acc
    const list = acc[item.sessionID]
    if (list) list.push(item)
    if (!list) acc[item.sessionID] = [item]
    return acc
  }, {})
}

function projectID(directory: string, projects: Project[]) {
  return projects.find((project) => project.worktree === directory || project.sandboxes?.includes(directory))?.id
}

function mergeSession(setStore: SetStoreFunction<State>, session: Session) {
  setStore("session", (list) => {
    const next = list.slice()
    const idx = next.findIndex((item) => item.id >= session.id)
    if (idx === -1) return [...next, session]
    if (next[idx]?.id === session.id) {
      next[idx] = session
      return next
    }
    next.splice(idx, 0, session)
    return next
  })
}

export function activeSessionStatuses(input: State["session_status"]) {
  return Object.fromEntries(
    Object.entries(input).filter(([, status]) => status?.type === "busy" || status?.type === "retry"),
  )
}

function sameSessionStatus(
  a: State["session_status"][string] | undefined,
  b: State["session_status"][string] | undefined,
) {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function mergeSessionStatusSnapshot(input: {
  current: State["session_status"]
  snapshot: State["session_status"]
  baseline?: State["session_status"]
}) {
  const active = activeSessionStatuses(input.current)
  const changedActive = Object.fromEntries(
    Object.entries(active).filter(([sessionID, status]) => !sameSessionStatus(input.baseline?.[sessionID], status)),
  )
  return {
    ...input.snapshot,
    ...changedActive,
  }
}

function warmSessions(input: {
  ids: string[]
  store: Store<State>
  setStore: SetStoreFunction<State>
  sdk: OpencodeClient
}) {
  const known = new Set(input.store.session.map((item) => item.id))
  const ids = [...new Set(input.ids)].filter((id) => !!id && !known.has(id))
  const warmed = new Set(input.store.session.map((item) => item.id))
  const missing = new Set<string>()
  if (ids.length === 0) return Promise.resolve({ warmed, missing })
  return Promise.all(
    ids.map((sessionID) =>
      retry(() => input.sdk.session.get({ sessionID }))
        .then((x) => {
          const session = x.data
          if (!session?.id) return
          warmed.add(session.id)
          mergeSession(input.setStore, session)
        })
        .catch((err) => {
          if (!isNotFoundError(err)) throw err
          missing.add(sessionID)
        }),
    ),
  ).then(() => ({ warmed, missing }))
}

function filterGroupedByWarmSessions<T>(grouped: Record<string, T[]>, result: { missing: Set<string> }) {
  const filtered = { ...grouped }
  for (const sessionID of result.missing) delete filtered[sessionID]
  return filtered
}

// Hydrate session/message/part trios returned by GET /external-result so the
// dock — which renders purely from parts — recovers after a reload (SSE
// message.part.updated is intentionally not in the replay buffer). Returns the
// questions the server still lists as pending, for the caller to reconcile into
// the global condition index.
//
// `pruneCandidateIDs` is the set of running-ready question part identities known
// locally *before* the fetch. Any of those the server no longer lists is a
// question answered while the app was away whose terminal event was missed; its
// stale local part is dropped here so the part-derived dock stops showing it.
// Scoping the prune to the pre-fetch snapshot keeps a question that arrived
// during the fetch from being pruned by a slightly older server view.
export function hydratePendingExternalResults(input: {
  store: Store<State>
  setStore: SetStoreFunction<State>
  entries: ReadonlyArray<{ session: Session; message: Message; part: Part }>
  pruneCandidateIDs?: ReadonlySet<string>
}): PendingExternalResultQuestion[] {
  const active: PendingExternalResultQuestion[] = []
  batch(() => {
    const activeIDs = new Set<string>()
    for (const entry of input.entries) {
      const session = entry.session
      const message = entry.message
      const part = entry.part
      if (!session?.id || !message?.id || !part?.id || !part.messageID) continue
      mergeSession(input.setStore, session)
      const pendingQuestion = pendingExternalResultQuestionFromPart(part)
      const localPart = input.store.part[part.messageID]?.find((item) => item.id === part.id)
      const localTerminalQuestion =
        pendingQuestion &&
        localPart?.type === "tool" &&
        localPart.tool === "question" &&
        localPart.state.status !== "running"
      if (pendingQuestion && !localTerminalQuestion) {
        activeIDs.add(pendingQuestion.id)
        active.push(pendingQuestion)
      }

      const messages = input.store.message[session.id]
      if (!messages) {
        input.setStore("message", session.id, [message])
      } else {
        const result = Binary.search(messages, message.id, (m) => m.id)
        if (result.found) {
          input.setStore("message", session.id, result.index, reconcile(message))
        } else {
          input.setStore(
            "message",
            session.id,
            produce((draft) => {
              draft.splice(result.index, 0, message)
            }),
          )
        }
      }

      if (localTerminalQuestion) continue
      const parts = input.store.part[part.messageID]
      if (!parts) {
        input.setStore("part", part.messageID, [part])
      } else {
        const result = Binary.search(parts, part.id, (p) => p.id)
        if (result.found) {
          input.setStore("part", part.messageID, result.index, reconcile(part))
        } else {
          input.setStore(
            "part",
            part.messageID,
            produce((draft) => {
              draft.splice(result.index, 0, part)
            }),
          )
        }
      }
    }
    if (input.pruneCandidateIDs?.size) {
      input.setStore(
        produce((draft) => {
          for (const messageID of Object.keys(draft.part)) {
            const parts = draft.part[messageID]
            if (!parts) continue
            const next = parts.filter((part) => {
              if (part.type !== "tool" || part.tool !== "question") return true
              if (part.state.status !== "running") return true
              if (part.state.metadata?.externalResultReady !== true) return true
              const id = `${part.messageID}:${part.callID}`
              if (!input.pruneCandidateIDs!.has(id)) return true
              return activeIDs.has(id)
            })
            if (next.length === parts.length) continue
            if (next.length > 0) draft.part[messageID] = next
            else delete draft.part[messageID]
          }
        }),
      )
    }
  })
  return active
}

// Identities (messageID:callID) of running-ready question parts in the local
// cache, captured before a GET /external-result fetch so the reconcile can tell
// an answered-while-away question (drop its stale part) from one that arrived
// mid-fetch (keep).
function snapshotRunningQuestionPartIDs(store: Store<State>) {
  const ids = new Set<string>()
  for (const parts of Object.values(store.part)) {
    for (const part of parts ?? []) {
      if (part.type !== "tool" || part.tool !== "question") continue
      if (part.state.status !== "running") continue
      if (part.state.metadata?.externalResultReady !== true) continue
      ids.add(`${part.messageID}:${part.callID}`)
    }
  }
  return ids
}

const inactiveQueryFn = async () => null

export const loadProvidersQuery = (directory: string | null) =>
  queryOptions<null>({ queryKey: [directory, "providers"], queryFn: inactiveQueryFn, enabled: false })

export const loadAgentsQuery = (directory: string | null) =>
  queryOptions<null>({ queryKey: [directory, "agents"], queryFn: inactiveQueryFn, enabled: false })

export async function bootstrapDirectory(input: {
  directory: string
  sdk: OpencodeClient
  store: Store<State>
  setStore: SetStoreFunction<State>
  vcsCache: VcsCache
  loadSessions: (directory: string) => Promise<void> | void
  translate: (key: string, vars?: Record<string, string | number>) => string
  global: {
    config: Config
    path: Path
    project: Project[]
    provider: ProviderListResponse
  }
  queryClient: QueryClient
  pendingQuestions: { reconcile: (directory: string, entries: PendingExternalResultQuestion[]) => void }
}) {
  const loading = input.store.status !== "complete"
  const seededProject = projectID(input.directory, input.global.project)
  const seededPath = input.global.path.directory === input.directory ? input.global.path : undefined
  if (seededProject) input.setStore("project", seededProject)
  if (seededPath) input.setStore("path", seededPath)
  if (input.store.provider.all.length === 0 && input.global.provider.all.length > 0) {
    input.setStore("provider", input.global.provider)
  }
  if (Object.keys(input.store.config).length === 0 && Object.keys(input.global.config).length > 0) {
    input.setStore("config", input.global.config)
  }
  if (loading || input.store.provider.all.length === 0) {
    input.setStore("provider_ready", false)
  }
  const statusBaseline = activeSessionStatuses(input.store.session_status)
  input.setStore("mcp_ready", false)
  input.setStore("mcp", {})
  input.setStore("lsp_ready", false)
  input.setStore("lsp", [])
  input.setStore("command_ready", false)
  input.setStore("external_result_ready", false)
  input.setStore("session_status_state", "loading")
  input.setStore("session_status_ready", false)
  input.setStore("session_status", reconcile(statusBaseline))
  if (loading) input.setStore("status", "partial")

  const fast = [() => Promise.resolve(input.loadSessions(input.directory))]

  const errs = errors(await runAll(fast))
  if (errs.length > 0) {
    console.error("Failed to bootstrap instance", errs[0])
    const project = getFilename(input.directory)
    showToast({
      variant: "error",
      title: input.translate("toast.project.reloadFailed.title", { project }),
      description: formatServerError(errs[0], input.translate),
    })
  }

  ;(async () => {
    const refreshProviders = () => {
      const rev = (providerRev.get(input.directory) ?? 0) + 1
      providerRev.set(input.directory, rev)
      return retry(() => input.sdk.provider.list())
        .then((x) => {
          if (providerRev.get(input.directory) !== rev) return
          input.queryClient.setQueryData(loadProvidersQuery(input.directory).queryKey, null)
          input.setStore("provider", normalizeProviderList(x.data!))
          input.setStore("provider_ready", true)
        })
        .catch((err) => {
          if (providerRev.get(input.directory) !== rev) return
          console.error("Failed to refresh provider list", err)
          const project = getFilename(input.directory)
          showToast({
            variant: "error",
            title: input.translate("toast.project.reloadFailed.title", { project }),
            description: formatServerError(err, input.translate),
          })
        })
    }

    void refreshProviders()

    const slow = [
      () =>
        input.queryClient.ensureQueryData({
          ...loadAgentsQuery(input.directory),
          queryFn: () =>
            retry(() => input.sdk.app.agents().then((x) => input.setStore("agent", normalizeAgentList(x.data)))).then(
              () => null,
            ),
        }),
      () => retry(() => input.sdk.config.get().then((x) => input.setStore("config", x.data!))),
      () =>
        retry(() =>
          input.sdk.session.status().then((x) => {
            input.setStore(
              "session_status",
              reconcile(
                mergeSessionStatusSnapshot({
                  current: input.store.session_status,
                  snapshot: x.data!,
                  baseline: statusBaseline,
                }),
              ),
            )
            input.setStore("session_status_state", "ready")
            input.setStore("session_status_ready", true)
          }),
        ).catch((err) => {
          input.setStore("session_status_state", "error")
          input.setStore("session_status_ready", false)
          throw err
        }),
      () =>
        seededProject
          ? Promise.resolve()
          : retry(() => input.sdk.project.current()).then((x) => input.setStore("project", x.data!.id)),
      () =>
        seededPath
          ? Promise.resolve()
          : retry(() =>
              input.sdk.path.get().then((x) => {
                input.setStore("path", x.data!)
                const next = projectID(x.data?.directory ?? input.directory, input.global.project)
                if (next) input.setStore("project", next)
              }),
            ),
      () =>
        retry(() =>
          input.sdk.vcs.get().then((x) => {
            const next = x.data ?? input.store.vcs
            input.setStore("vcs", next)
            if (next) input.vcsCache.setStore("value", next)
          }),
        ),
      () =>
        retry(() =>
          input.sdk.command.list().then((x) => {
            input.setStore("command", x.data ?? [])
            input.setStore("command_ready", true)
          }),
        ).catch((err) => {
          input.setStore("command", [])
          input.setStore("command_ready", false)
          throw err
        }),
      () =>
        retry(() =>
          input.sdk.permission.list().then((x) => {
            const ids = (x.data ?? []).map((perm) => perm?.sessionID).filter((id): id is string => !!id)
            return warmSessions({ ids, store: input.store, setStore: input.setStore, sdk: input.sdk }).then((warm) => {
              const grouped = filterGroupedByWarmSessions(
                groupBySession(
                  (x.data ?? []).filter((perm): perm is PermissionRequest => !!perm?.id && !!perm.sessionID),
                ),
                warm,
              )
              return batch(() => {
                for (const sessionID of Object.keys(input.store.permission)) {
                  if (grouped[sessionID]) continue
                  input.setStore("permission", sessionID, [])
                }
                for (const [sessionID, permissions] of Object.entries(grouped)) {
                  input.setStore(
                    "permission",
                    sessionID,
                    reconcile(
                      permissions.filter((p) => !!p?.id).sort((a, b) => cmp(a.id, b.id)),
                      { key: "id" },
                    ),
                  )
                }
              })
            })
          }),
        ),
      () =>
        retry(() => {
          const pruneCandidateIDs = snapshotRunningQuestionPartIDs(input.store)
          return input.sdk.externalResult.list().then((x) => {
            const entries = (x.data ?? []).filter(
              (entry): entry is { session: Session; message: Message; part: Part } =>
                !!entry?.session?.id && !!entry.message?.id && !!entry.part?.id,
            )
            const active = hydratePendingExternalResults({
              store: input.store,
              setStore: input.setStore,
              entries,
              pruneCandidateIDs,
            })
            input.pendingQuestions.reconcile(input.directory, active)
            input.setStore("external_result_ready", true)
          })
        }).catch((err) => {
          input.setStore("external_result_ready", false)
          // Hydrate is best-effort: a transient failure should not surface
          // the project-level "reloadFailed" toast. The dock recovers on
          // the next SSE message.part.updated for live questions, or on
          // the next bootstrap pass for cold-open ones.
          console.warn("Failed to hydrate pending external-result questions", err)
        }),
      () => Promise.resolve(input.loadSessions(input.directory)),
      () =>
        retry(() =>
          input.sdk.mcp.status().then((x) => {
            input.setStore("mcp", x.data!)
            input.setStore("mcp_ready", true)
          }),
        ),
      () =>
        retry(() => {
          const knownIds = new Set(Object.keys(input.store.automation))
          return input.sdk.automation.list().then((x) => {
            mergeAutomationList(input.store, input.setStore, x.data?.items ?? [], knownIds)
          })
        }),
    ]

    await waitForPaint()
    const slowErrs = errors(await runAll(slow))
    if (slowErrs.length > 0) {
      console.error("Failed to finish bootstrap instance", slowErrs[0])
      const project = getFilename(input.directory)
      showToast({
        variant: "error",
        title: input.translate("toast.project.reloadFailed.title", { project }),
        description: formatServerError(slowErrs[0], input.translate),
      })
    }

    if (loading && errs.length === 0 && slowErrs.length === 0) input.setStore("status", "complete")
  })()
}
