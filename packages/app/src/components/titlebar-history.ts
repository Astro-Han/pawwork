const MAX_TITLEBAR_HISTORY = 100

export type TitlebarAction = "back" | "forward" | undefined

// Surface routes carry their close-to-origin stack in navigation state (see
// pages/layout/surface-routes.ts), so an entry must keep the state alongside
// the path: replaying a bare path would strand the surface's close on its
// fallback instead of returning to the recorded origin.
export type TitlebarEntry = { to: string; state?: unknown }

export type TitlebarHistory = {
  stack: TitlebarEntry[]
  index: number
  action: TitlebarAction
}

export function applyPath(state: TitlebarHistory, current: TitlebarEntry, max = MAX_TITLEBAR_HISTORY): TitlebarHistory {
  if (!state.stack.length) {
    const stack = current.to === "/" ? [current] : [{ to: "/" }, current]
    return { stack, index: stack.length - 1, action: undefined }
  }

  const active = state.stack[state.index]
  if (active && current.to === active.to) {
    if (state.action) return { ...state, action: undefined }
    if (active.state === current.state) return state
    // Same path, new navigation state: refresh the stored entry so a later
    // replay restores what the location actually carried.
    const stack = state.stack.slice()
    stack[state.index] = current
    return { ...state, stack }
  }

  if (state.action) return { ...state, action: undefined }

  return pushPath(state, current, max)
}

function pushPath(state: TitlebarHistory, entry: TitlebarEntry, max = MAX_TITLEBAR_HISTORY): TitlebarHistory {
  const stack = state.stack.slice(0, state.index + 1).concat(entry)
  const next = trimHistory(stack, stack.length - 1, max)
  return { ...state, ...next, action: undefined }
}

function trimHistory(stack: TitlebarEntry[], index: number, max = MAX_TITLEBAR_HISTORY) {
  if (stack.length <= max) return { stack, index }
  const cut = stack.length - max
  return {
    stack: stack.slice(cut),
    index: Math.max(0, index - cut),
  }
}

export function backPath(state: TitlebarHistory) {
  if (state.index <= 0) return
  const index = state.index - 1
  const entry = state.stack[index]
  if (!entry) return
  return { state: { ...state, index, action: "back" as const }, entry }
}

export function forwardPath(state: TitlebarHistory) {
  if (state.index >= state.stack.length - 1) return
  const index = state.index + 1
  const entry = state.stack[index]
  if (!entry) return
  return { state: { ...state, index, action: "forward" as const }, entry }
}
