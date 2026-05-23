import type { TodoPhase, TodoSourceKind } from "./todo-model"

export const TODO_DOCK_COMPLETING_DELAY_MS = 3000

export type TodoDockMachineState =
  | {
      kind: "hidden"
      dock: false
      opening: false
      completing: false
      activeSessionIDs: ReadonlySet<string>
    }
  | {
      kind: "visible-active"
      sessionID?: string
      dock: true
      opening: boolean
      completing: false
      activeSessionIDs: ReadonlySet<string>
    }
  | {
      kind: "visible-completing"
      sessionID?: string
      lifecycleSignature: string
      dock: true
      opening: false
      completing: true
      activeSessionIDs: ReadonlySet<string>
    }
  | {
      kind: "hidden-terminal"
      sessionID?: string
      lifecycleSignature: string
      dock: false
      opening: false
      completing: false
      activeSessionIDs: ReadonlySet<string>
    }

export type TodoDockInput = {
  sessionID?: string
  count: number
  phase: TodoPhase
  lifecycleSignature: string
  dockEligible?: boolean
  restored?: boolean
  // Semantic flag from the source selector. The reducer primarily uses active
  // session history to decide whether terminal snapshots complete a currently
  // active dock or remain hidden historical state.
  historicalTerminal?: boolean
}

export type TodoDockTransition =
  | { type: "snapshot"; input: TodoDockInput }
  | { type: "hideTimerElapsed"; sessionID?: string; lifecycleSignature: string }
  | { type: "animationFrameElapsed" }

export type TodoDockRestoreTrackerInput = {
  sessionID?: string
  known: boolean
  source?: TodoSourceKind
  count: number
  phase: TodoPhase
}

const isToolPartsSource = (source?: TodoSourceKind) => source === "primary-parts" || source === "fallback-parts"

export function createTodoDockRestoreTracker() {
  let sessionID: string | undefined
  let primed = false

  return (input: TodoDockRestoreTrackerInput) => {
    if (!input.sessionID) {
      sessionID = undefined
      primed = false
      return false
    }

    if (sessionID !== input.sessionID) {
      sessionID = input.sessionID
      primed = false
    }

    const active = input.count > 0 && input.phase === "active"
    const restored =
      !primed && active && (isToolPartsSource(input.source) || (input.known && !isToolPartsSource(input.source)))
    if (input.known) primed = true
    return restored
  }
}

export function todoDockHiddenState(activeSessionIDs: ReadonlySet<string> = new Set()): TodoDockMachineState {
  return { kind: "hidden", dock: false, opening: false, completing: false, activeSessionIDs }
}

const forgetSession = (activeSessionIDs: ReadonlySet<string>, sessionID?: string): ReadonlySet<string> => {
  if (!sessionID || !activeSessionIDs.has(sessionID)) return activeSessionIDs
  const next = new Set(activeSessionIDs)
  next.delete(sessionID)
  return next
}

const rememberSession = (activeSessionIDs: ReadonlySet<string>, sessionID?: string): ReadonlySet<string> => {
  if (!sessionID || activeSessionIDs.has(sessionID)) return activeSessionIDs
  const next = new Set(activeSessionIDs)
  next.add(sessionID)
  return next
}

const stateSessionID = (state: TodoDockMachineState) => {
  if (state.kind === "hidden") return undefined
  return state.sessionID
}

export function reduceTodoDockState(state: TodoDockMachineState, transition: TodoDockTransition): TodoDockMachineState {
  if (transition.type === "animationFrameElapsed") {
    if (state.kind !== "visible-active" || !state.opening) return state
    return { ...state, opening: false }
  }

  if (transition.type === "hideTimerElapsed") {
    if (state.kind !== "visible-completing") return state
    if (state.sessionID !== transition.sessionID || state.lifecycleSignature !== transition.lifecycleSignature)
      return state
    return {
      kind: "hidden-terminal",
      sessionID: state.sessionID,
      lifecycleSignature: state.lifecycleSignature,
      dock: false,
      opening: false,
      completing: false,
      activeSessionIDs: forgetSession(state.activeSessionIDs, state.sessionID),
    }
  }

  const input = transition.input
  const previousSessionID = stateSessionID(state)
  const activeSessionIDs =
    previousSessionID && previousSessionID !== input.sessionID
      ? forgetSession(state.activeSessionIDs, previousSessionID)
      : state.activeSessionIDs

  if (input.count === 0 || input.phase === "empty") {
    return todoDockHiddenState(forgetSession(activeSessionIDs, input.sessionID))
  }

  if (input.phase === "active" && input.dockEligible !== false) {
    const hidden = !state.dock
    return {
      kind: "visible-active",
      sessionID: input.sessionID,
      dock: true,
      opening: hidden && input.restored !== true,
      completing: false,
      activeSessionIDs: rememberSession(activeSessionIDs, input.sessionID),
    }
  }

  if (state.kind === "visible-completing") {
    if (state.sessionID === input.sessionID && state.lifecycleSignature === input.lifecycleSignature) return state
  }

  if (!input.sessionID || !activeSessionIDs.has(input.sessionID)) {
    return {
      kind: "hidden-terminal",
      sessionID: input.sessionID,
      lifecycleSignature: input.lifecycleSignature,
      dock: false,
      opening: false,
      completing: false,
      activeSessionIDs,
    }
  }

  return {
    kind: "visible-completing",
    sessionID: input.sessionID,
    lifecycleSignature: input.lifecycleSignature,
    dock: true,
    opening: false,
    completing: true,
    activeSessionIDs,
  }
}
