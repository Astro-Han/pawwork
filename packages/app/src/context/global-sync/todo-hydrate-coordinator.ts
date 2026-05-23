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

export function createTodoHydrateCoordinator(options?: { sessionLimit?: number; directoryLimit?: number }) {
  const sessionLimit = options?.sessionLimit ?? SESSION_CACHE_LIMIT
  const directoryLimit = options?.directoryLimit ?? MAX_DIR_STORES
  const seen = new Map<string, Set<string>>()
  const tokenEpoch = new Map<string, number>()
  const [state, setState] = createStore({
    pending: {} as Record<string, TodoHydrateReason | undefined>,
    invalidated: {} as Record<string, true | undefined>,
    recoveryEpoch: 0,
    validatedRecovery: {} as Record<string, number | undefined>,
  })

  const bumpToken = (directory: string, sessionID: string) => {
    const key = keyFor(directory, sessionID)
    const next = (tokenEpoch.get(key) ?? 0) + 1
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

  const removeDirectoryState = (directory: string) => {
    for (const key of Object.keys(state.pending)) {
      if (key.startsWith(`${directory}\0`)) {
        setState(
          "pending",
          produce((draft) => {
            delete draft[key]
          }),
        )
      }
    }
    for (const key of Object.keys(state.validatedRecovery)) {
      if (key.startsWith(`${directory}\0`)) {
        setState(
          "validatedRecovery",
          produce((draft) => {
            delete draft[key]
          }),
        )
      }
    }
    for (const key of Array.from(tokenEpoch.keys())) {
      if (key.startsWith(`${directory}\0`)) tokenEpoch.delete(key)
    }
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
    if (local.length > 0) evictions.push({ directory, sessionIDs: local })

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
    seen.get(directory)?.delete(sessionID)
    bumpToken(directory, sessionID)
    clearPending(directory, sessionID)
  }

  const invalidateSession = (sessionID: string) => {
    if (!sessionID) return
    setState("invalidated", sessionID, true)
    for (const directory of seen.keys()) {
      forgetSession(directory, sessionID)
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
