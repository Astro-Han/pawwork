import { createEffect, onCleanup } from "solid-js"
import { createSessionBlockers } from "@/pages/session/blockers/use-session-blockers"
import { createSessionTodoModel } from "@/pages/session/todos/use-session-todos"
import { composerEnabled, composerStateProbe } from "@/testing/session-composer"

export function createSessionComposerState(input: {
  sessionID: () => string | undefined
  fallbackSessionID?: () => string | undefined
}) {
  const activeSessionID = input.sessionID
  const blockers = createSessionBlockers({ sessionID: activeSessionID })
  const todo = createSessionTodoModel({ sessionID: activeSessionID, fallbackSessionID: input.fallbackSessionID })

  createEffect(() => {
    if (!composerEnabled()) return
    const probe = composerStateProbe(activeSessionID())
    probe.set({
      dock: todo.dock(),
      opening: todo.opening(),
      completing: todo.completing(),
      count: todo.todos().length,
      states: todo.todos().map((todo) => todo.status),
    })
    onCleanup(() => probe.drop())
  })

  return {
    blocked: blockers.blocked,
    recoveringQuestion: blockers.recoveringQuestion,
    questionRequest: blockers.questionRequest,
    permissionRequest: blockers.permissionRequest,
    permissionResponding: blockers.permissionResponding,
    decide: blockers.decide,
    todos: todo.todos,
    dock: todo.dock,
    opening: todo.opening,
  }
}

export type SessionComposerState = ReturnType<typeof createSessionComposerState>
