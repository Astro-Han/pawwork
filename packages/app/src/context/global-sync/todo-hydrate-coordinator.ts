import { createStore, produce } from "solid-js/store"
import { SESSION_CACHE_LIMIT, pickSessionCacheEvictions } from "./session-cache"
import { MAX_DIR_STORES } from "./types"

export type TodoHydrateReason = "visible" | "busy" | "recovery"

export type TodoHydrateToken = {
  directory: string
  sessionID: string
  epoch: number
  reason: TodoHydrateReason
  targetRecoveryEpoch?: number
}

export type SessionRequestEviction = {
  directory: string
  sessionIDs: string[]
}

export type TodoHydrateCoordinator = ReturnType<typeof createTodoHydrateCoordinator>

const keyFor = (directory: string, sessionID: string) => `${directory}\0${sessionID}`

const splitKey = (key: string) => {
  const index = key.indexOf("\0")
  if (index < 0) return undefined
  return { directory: key.slice(0, index), sessionID: key.slice(index + 1) }
}

export function createTodoHydrateCoordinator(options?: { sessionLimit?: number; directoryLimit?: number }) {
  const sessionLimit = options?.sessionLimit ?? SESSION_CACHE_LIMIT
  const directoryLimit = options?.directoryLimit ?? MAX_DIR_STORES
  const seen = new Map<string, Set<string>>()
  const tokenEpoch = new Map<string, number>()
  let nextTokenEpoch = 0
  const [state, setState] = createStore({
    pending: {} as Record<string, TodoHydrateReason | undefined>,
    invalidated: {} as Record<string, true | undefined>,
    recoveryEpoch: 0,
    validatedRecovery: {} as Record<string, number | undefined>,
  })

  const bumpToken = (directory: string, sessionID: string) => {
    const key = keyFor(directory, sessionID)
    const next = nextTokenEpoch + 1
    nextTokenEpoch = next
    tokenEpoch.set(key, next)
    return next
  }

  const clearPending = (directory: string, sessionID: string) => {
    const key = keyFor(directory, sessionID)
    setState(
      "pending",
      produce((draft) => {
        delete draft[key]
      }),
    )
  }

  const clearSessionState = (directory: string, sessionID: string) => {
    const key = keyFor(directory, sessionID)
    seen.get(directory)?.delete(sessionID)
    tokenEpoch.delete(key)
    setState(
      produce((draft) => {
        delete draft.pending[key]
        delete draft.validatedRecovery[key]
      }),
    )
  }

  const removeDirectoryState = (directory: string) => {
    const sessionIDs = new Set(seen.get(directory) ?? [])
    for (const key of Object.keys(state.pending)) {
      const parsed = splitKey(key)
      if (parsed?.directory === directory) sessionIDs.add(parsed.sessionID)
    }
    for (const key of Object.keys(state.validatedRecovery)) {
      const parsed = splitKey(key)
      if (parsed?.directory === directory) sessionIDs.add(parsed.sessionID)
    }
    for (const key of Array.from(tokenEpoch.keys())) {
      const parsed = splitKey(key)
      if (parsed?.directory === directory) sessionIDs.add(parsed.sessionID)
    }
    for (const sessionID of sessionIDs) clearSessionState(directory, sessionID)
    seen.delete(directory)
  }

  const touch = (directory: string, sessionID: string): SessionRequestEviction[] => {
    if (!directory || !sessionID) return []
    let tracked = seen.get(directory)
    if (tracked) {
      seen.delete(directory)
      seen.set(directory, tracked)
    } else {
      tracked = new Set<string>()
      seen.set(directory, tracked)
    }

    const evictions: SessionRequestEviction[] = []
    const local = pickSessionCacheEvictions({ seen: tracked, keep: sessionID, limit: sessionLimit })
    if (local.length > 0) {
      for (const evictedSessionID of local) clearSessionState(directory, evictedSessionID)
      evictions.push({ directory, sessionIDs: local })
    }

    while (seen.size > directoryLimit) {
      const staleDirectory = seen.keys().next().value
      if (!staleDirectory) break
      const sessionIDs = [...(seen.get(staleDirectory) ?? [])]
      seen.delete(staleDirectory)
      removeDirectoryState(staleDirectory)
      if (sessionIDs.length > 0) evictions.push({ directory: staleDirectory, sessionIDs })
    }

    return evictions
  }

  const has = (directory: string, sessionID: string) => seen.get(directory)?.has(sessionID) ?? false

  const scheduleHydrate = (directory: string, sessionID: string, reason: TodoHydrateReason) => {
    if (!directory || !sessionID) return
    setState("pending", keyFor(directory, sessionID), reason)
  }

  const beginHydrate = (directory: string, sessionID: string, reason: TodoHydrateReason): TodoHydrateToken => {
    scheduleHydrate(directory, sessionID, reason)
    return {
      directory,
      sessionID,
      reason,
      epoch: bumpToken(directory, sessionID),
      targetRecoveryEpoch: reason === "recovery" ? state.recoveryEpoch : undefined,
    }
  }

  const isCurrent = (token: TodoHydrateToken) => {
    if (!has(token.directory, token.sessionID)) return false
    return tokenEpoch.get(keyFor(token.directory, token.sessionID)) === token.epoch
  }

  const completeHydrate = (
    token: TodoHydrateToken,
    outcome: { cacheAccepted: boolean; recoveryValidated: boolean; liveWritesReopened: boolean },
  ) => {
    if (!isCurrent(token)) return
    clearPending(token.directory, token.sessionID)
    if (token.reason === "recovery" && outcome.recoveryValidated && token.targetRecoveryEpoch !== undefined) {
      setState("validatedRecovery", keyFor(token.directory, token.sessionID), token.targetRecoveryEpoch)
    }
    if (outcome.liveWritesReopened) {
      setState(
        "invalidated",
        produce((draft) => {
          delete draft[token.sessionID]
        }),
      )
    }
  }

  const forgetSession = (directory: string, sessionID: string) => {
    clearSessionState(directory, sessionID)
  }

  const invalidateSession = (sessionID: string) => {
    if (!sessionID) return
    setState("invalidated", sessionID, true)
    const directories = new Set<string>()
    for (const [directory, sessions] of seen) {
      if (sessions.has(sessionID)) directories.add(directory)
    }
    for (const key of Object.keys(state.pending)) {
      const parsed = splitKey(key)
      if (parsed?.sessionID === sessionID) directories.add(parsed.directory)
    }
    for (const key of Object.keys(state.validatedRecovery)) {
      const parsed = splitKey(key)
      if (parsed?.sessionID === sessionID) directories.add(parsed.directory)
    }
    for (const key of Array.from(tokenEpoch.keys())) {
      const parsed = splitKey(key)
      if (parsed?.sessionID === sessionID) directories.add(parsed.directory)
    }
    for (const directory of directories) {
      clearSessionState(directory, sessionID)
    }
  }

  const clearDirectory = (directory: string) => {
    seen.delete(directory)
    removeDirectoryState(directory)
  }

  const markGlobalRecovery = () => {
    const next = state.recoveryEpoch + 1
    setState("recoveryEpoch", next)
    return next
  }

  return {
    touch,
    has,
    scheduleHydrate,
    beginHydrate,
    isCurrent,
    completeHydrate,
    cancelHydrate(directory: string, sessionID: string) {
      bumpToken(directory, sessionID)
      clearPending(directory, sessionID)
    },
    isPending: (directory: string, sessionID: string) => state.pending[keyFor(directory, sessionID)] !== undefined,
    isAuthoritativelyInvalidated: (sessionID: string) => state.invalidated[sessionID] === true,
    canAcceptLiveTodo: (_directory: string, sessionID: string) => state.invalidated[sessionID] !== true,
    invalidate: forgetSession,
    invalidateSession,
    clearDirectory,
    markGlobalRecovery,
    recoveryEpoch: () => state.recoveryEpoch,
    validatedRecoveryEpoch: (directory: string, sessionID: string) =>
      state.validatedRecovery[keyFor(directory, sessionID)] ?? 0,
  }
}
