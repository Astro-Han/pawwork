import type { TodoPhase } from "./todo-model"

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
  historicalTerminal?: boolean
}

export type TodoDockTransition =
  | { type: "snapshot"; input: TodoDockInput }
  | { type: "hideTimerElapsed"; sessionID?: string; lifecycleSignature: string }
  | { type: "animationFrameElapsed" }

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
  if (input.count === 0 || input.phase === "empty") {
    return todoDockHiddenState(forgetSession(state.activeSessionIDs, input.sessionID))
  }

  if (input.phase === "active" && input.dockEligible !== false) {
    const hidden = !state.dock
    return {
      kind: "visible-active",
      sessionID: input.sessionID,
      dock: true,
      opening: hidden,
      completing: false,
      activeSessionIDs: rememberSession(state.activeSessionIDs, input.sessionID),
    }
  }

  if (state.kind === "visible-completing") {
    if (state.sessionID === input.sessionID && state.lifecycleSignature === input.lifecycleSignature) return state
  }

  if (!input.sessionID || !state.activeSessionIDs.has(input.sessionID)) {
    return {
      kind: "hidden-terminal",
      sessionID: input.sessionID,
      lifecycleSignature: input.lifecycleSignature,
      dock: false,
      opening: false,
      completing: false,
      activeSessionIDs: state.activeSessionIDs,
    }
  }

  return {
    kind: "visible-completing",
    sessionID: input.sessionID,
    lifecycleSignature: input.lifecycleSignature,
    dock: true,
    opening: false,
    completing: true,
    activeSessionIDs: state.activeSessionIDs,
  }
}
