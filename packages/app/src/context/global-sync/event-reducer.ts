import { Binary } from "@opencode-ai/util/binary"
import { produce, reconcile, type SetStoreFunction, type Store } from "solid-js/store"
import type {
  Message,
  Part,
  PermissionRequest,
  Project,
  Session,
  SessionStatus,
  Todo,
  TodoSnapshot,
} from "@opencode-ai/sdk/v2/client"
import type { State, VcsCache } from "./types"
import { trimSessions } from "./session-trim"
import { dropSessionCaches } from "./session-cache"
import { message as clean } from "@/utils/diffs"
import type { createBlockerTerminalCache } from "./blocker-terminal-cache"
import type { TodoHydrateCoordinator } from "./todo-hydrate-coordinator"

const SKIP_PARTS = new Set(["patch", "step-start", "step-finish"])
type AcceptSessionTodo = (sessionID: string, snapshot: TodoSnapshot) => boolean
type ClearSessionTodoAuthoritative = (sessionID: string) => void
type TodoHydrateBoundary = Partial<Pick<TodoHydrateCoordinator, "canAcceptLiveTodo" | "invalidateSession">>

function todoSnapshotFromProperties(properties: unknown): { sessionID: string; snapshot: TodoSnapshot } | undefined {
  if (!properties || typeof properties !== "object") return undefined
  const props = properties as { sessionID?: unknown; revision?: unknown; todos?: unknown }
  if (typeof props.sessionID !== "string") return undefined
  if (typeof props.revision !== "number") return undefined
  if (!Array.isArray(props.todos)) return undefined
  return { sessionID: props.sessionID, snapshot: { revision: props.revision, todos: props.todos as Todo[] } }
}

function todoSnapshotFromPart(part: Part): { sessionID: string; snapshot: TodoSnapshot } | undefined {
  if (part.type !== "tool") return undefined
  if (part.tool !== "todowrite") return undefined
  if (part.state.status !== "completed") return undefined
  if (!part.sessionID) return undefined
  const metadata = part.state.metadata
  if (!metadata || typeof metadata !== "object") return undefined
  const snapshot = metadata as { revision?: unknown; todos?: unknown }
  if (typeof snapshot.revision !== "number") return undefined
  if (!Array.isArray(snapshot.todos)) return undefined
  return { sessionID: part.sessionID, snapshot: { revision: snapshot.revision, todos: snapshot.todos as Todo[] } }
}

function acceptLiveTodo(input: {
  directory: string
  sessionID: string
  snapshot: TodoSnapshot
  acceptSessionTodo?: AcceptSessionTodo
  todoHydrate?: Pick<TodoHydrateBoundary, "canAcceptLiveTodo">
}) {
  if (input.todoHydrate?.canAcceptLiveTodo?.(input.directory, input.sessionID) === false) return false
  return input.acceptSessionTodo?.(input.sessionID, input.snapshot) ?? false
}

export function applyGlobalEvent(input: {
  event: { type: string; properties?: unknown }
  project: Project[]
  setGlobalProject: (next: Project[] | ((draft: Project[]) => void)) => void
  refresh: () => void
}) {
  if (input.event.type === "global.disposed" || input.event.type === "server.connected") {
    input.refresh()
    return
  }

  if (input.event.type !== "project.updated") return
  const properties = input.event.properties as Project
  const result = Binary.search(input.project, properties.id, (s) => s.id)
  if (result.found) {
    input.setGlobalProject((draft) => {
      draft[result.index] = { ...draft[result.index], ...properties }
    })
    return
  }
  input.setGlobalProject((draft) => {
    draft.splice(result.index, 0, properties)
  })
}

function cleanupSessionCaches(input: {
  setStore: SetStoreFunction<State>
  sessionID: string
  clearSessionTodoAuthoritative?: ClearSessionTodoAuthoritative
  todoHydrate?: Pick<TodoHydrateBoundary, "invalidateSession">
}) {
  const { setStore, sessionID } = input
  if (!sessionID) return
  input.clearSessionTodoAuthoritative?.(sessionID)
  input.todoHydrate?.invalidateSession?.(sessionID)
  setStore(
    produce((draft) => {
      dropSessionCaches(draft, [sessionID])
    }),
  )
}

export function cleanupDroppedSessionCaches(
  store: Store<State>,
  setStore: SetStoreFunction<State>,
  next: Session[],
) {
  const keep = new Set(next.map((item) => item.id))
  const stale = [
    ...Object.keys(store.message),
    ...Object.keys(store.turn_change_aggregate),
    ...Object.keys(store.todo),
    ...Object.keys(store.permission),
    ...Object.keys(store.session_status),
    ...Object.values(store.part)
      .map((parts) => parts?.find((part) => !!part?.sessionID)?.sessionID)
      .filter((sessionID): sessionID is string => !!sessionID),
  ].filter((sessionID, index, list) => !keep.has(sessionID) && list.indexOf(sessionID) === index)
  if (stale.length === 0) return
  setStore(
    produce((draft) => {
      dropSessionCaches(draft, stale)
    }),
  )
}

export function applyDetachedDirectoryEvent(input: {
  directory: string
  event: { type: string; properties?: unknown }
  acceptSessionTodo?: AcceptSessionTodo
  clearSessionTodoAuthoritative?: ClearSessionTodoAuthoritative
  todoHydrate?: TodoHydrateBoundary
}) {
  if (!input.event.properties || typeof input.event.properties !== "object") return false
  switch (input.event.type) {
    case "todo.updated": {
      const todo = todoSnapshotFromProperties(input.event.properties)
      if (!todo) return false
      acceptLiveTodo({
        directory: input.directory,
        sessionID: todo.sessionID,
        snapshot: todo.snapshot,
        acceptSessionTodo: input.acceptSessionTodo,
        todoHydrate: input.todoHydrate,
      })
      return true
    }
    case "session.deleted": {
      const info = (input.event.properties as { info?: Session }).info
      if (!info?.id) return false
      input.clearSessionTodoAuthoritative?.(info.id)
      input.todoHydrate?.invalidateSession?.(info.id)
      return true
    }
    case "session.updated": {
      const info = (input.event.properties as { info?: Session }).info
      if (!info?.id || !info.time?.archived) return false
      input.clearSessionTodoAuthoritative?.(info.id)
      input.todoHydrate?.invalidateSession?.(info.id)
      return true
    }
    default:
      return false
  }
}

export function applyDirectoryEvent(input: {
  event: { type: string; properties?: unknown }
  store: Store<State>
  setStore: SetStoreFunction<State>
  push: (directory: string) => void
  directory: string
  loadLsp: () => void
  vcsCache?: VcsCache
  acceptSessionTodo?: AcceptSessionTodo
  clearSessionTodoAuthoritative?: ClearSessionTodoAuthoritative
  todoHydrate?: TodoHydrateBoundary
  blockerTerminals?: ReturnType<typeof createBlockerTerminalCache>
}) {
  const event = input.event
  switch (event.type) {
    case "server.instance.disposed": {
      input.push(input.directory)
      return
    }
    case "session.created": {
      const info = (event.properties as { info: Session }).info
      const result = Binary.search(input.store.session, info.id, (s) => s.id)
      if (result.found) {
        input.setStore("session", result.index, reconcile(info))
        break
      }
      const next = input.store.session.slice()
      next.splice(result.index, 0, info)
      input.setStore("session", reconcile(next, { key: "id" }))
      if (!info.parentID) input.setStore("sessionTotal", (value) => value + 1)
      break
    }
    case "session.updated": {
      const info = (event.properties as { info: Session }).info
      const result = Binary.search(input.store.session, info.id, (s) => s.id)
      if (info.time.archived) {
        if (result.found) {
          input.setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 1)
            }),
          )
        }
        cleanupSessionCaches({
          setStore: input.setStore,
          sessionID: info.id,
          clearSessionTodoAuthoritative: input.clearSessionTodoAuthoritative,
          todoHydrate: input.todoHydrate,
        })
        if (info.parentID) break
        input.setStore("sessionTotal", (value) => Math.max(0, value - 1))
        break
      }
      if (result.found) {
        input.setStore("session", result.index, reconcile(info))
        break
      }
      const next = input.store.session.slice()
      next.splice(result.index, 0, info)
      input.setStore("session", reconcile(next, { key: "id" }))
      break
    }
    case "session.deleted": {
      const info = (event.properties as { info: Session }).info
      const result = Binary.search(input.store.session, info.id, (s) => s.id)
      if (result.found) {
        input.setStore(
          "session",
          produce((draft) => {
            draft.splice(result.index, 1)
          }),
        )
      }
      cleanupSessionCaches({
        setStore: input.setStore,
        sessionID: info.id,
        clearSessionTodoAuthoritative: input.clearSessionTodoAuthoritative,
        todoHydrate: input.todoHydrate,
      })
      if (info.parentID) break
      input.setStore("sessionTotal", (value) => Math.max(0, value - 1))
      break
    }
    case "session.turn_change_invalidated": {
      const props = event.properties as { sessionID: string }
      input.setStore("turn_change_aggregate", props.sessionID, undefined)
      break
    }
    case "todo.updated": {
      const todo = todoSnapshotFromProperties(event.properties)
      if (!todo) break
      const accepted = acceptLiveTodo({
        directory: input.directory,
        sessionID: todo.sessionID,
        snapshot: todo.snapshot,
        acceptSessionTodo: input.acceptSessionTodo,
        todoHydrate: input.todoHydrate,
      })
      if (accepted) input.setStore("todo", todo.sessionID, reconcile(todo.snapshot.todos, { key: "id" }))
      break
    }
    case "session.status": {
      const props = event.properties as { sessionID: string; status: SessionStatus }
      input.setStore("session_status", props.sessionID, reconcile(props.status))
      break
    }
    case "message.updated": {
      const info = clean((event.properties as { info: Message }).info)
      const messages = input.store.message[info.sessionID]
      if (!messages) {
        input.setStore("message", info.sessionID, [info])
        break
      }
      const result = Binary.search(messages, info.id, (m) => m.id)
      if (result.found) {
        input.setStore("message", info.sessionID, result.index, reconcile(info))
        break
      }
      input.setStore(
        "message",
        info.sessionID,
        produce((draft) => {
          draft.splice(result.index, 0, info)
        }),
      )
      break
    }
    case "message.removed": {
      const props = event.properties as { sessionID: string; messageID: string }
      input.setStore(
        produce((draft) => {
          const messages = draft.message[props.sessionID]
          if (messages) {
            const result = Binary.search(messages, props.messageID, (m) => m.id)
            if (result.found) messages.splice(result.index, 1)
          }
          delete draft.part[props.messageID]
        }),
      )
      break
    }
    case "message.part.updated": {
      const part = (event.properties as { part: Part }).part
      if (SKIP_PARTS.has(part.type)) break
      const todo = todoSnapshotFromPart(part)
      if (todo) {
        const accepted = acceptLiveTodo({
          directory: input.directory,
          sessionID: todo.sessionID,
          snapshot: todo.snapshot,
          acceptSessionTodo: input.acceptSessionTodo,
          todoHydrate: input.todoHydrate,
        })
        if (accepted) input.setStore("todo", todo.sessionID, reconcile(todo.snapshot.todos, { key: "id" }))
      }
      const parts = input.store.part[part.messageID]
      if (!parts) {
        input.setStore("part", part.messageID, [part])
        break
      }
      const result = Binary.search(parts, part.id, (p) => p.id)
      if (result.found) {
        input.setStore("part", part.messageID, result.index, reconcile(part))
        break
      }
      input.setStore(
        "part",
        part.messageID,
        produce((draft) => {
          draft.splice(result.index, 0, part)
        }),
      )
      break
    }
    case "message.part.removed": {
      const props = event.properties as { messageID: string; partID: string }
      const parts = input.store.part[props.messageID]
      if (!parts) break
      const result = Binary.search(parts, props.partID, (p) => p.id)
      if (result.found) {
        input.setStore(
          produce((draft) => {
            const list = draft.part[props.messageID]
            if (!list) return
            const next = Binary.search(list, props.partID, (p) => p.id)
            if (!next.found) return
            list.splice(next.index, 1)
            if (list.length === 0) delete draft.part[props.messageID]
          }),
        )
      }
      break
    }
    case "message.part.delta": {
      const props = event.properties as { messageID: string; partID: string; field: string; delta: string }
      const parts = input.store.part[props.messageID]
      if (!parts) break
      const result = Binary.search(parts, props.partID, (p) => p.id)
      if (!result.found) break
      input.setStore(
        "part",
        props.messageID,
        produce((draft) => {
          const part = draft[result.index]
          const field = props.field as keyof typeof part
          const existing = part[field] as string | undefined
          ;(part[field] as string) = (existing ?? "") + props.delta
        }),
      )
      break
    }
    case "vcs.branch.updated": {
      const props = event.properties as { branch?: string }
      if (input.store.vcs?.branch === props.branch) break
      const next = { ...input.store.vcs, branch: props.branch }
      input.setStore("vcs", next)
      if (input.vcsCache) input.vcsCache.setStore("value", next)
      break
    }
    case "permission.asked": {
      const permission = event.properties as PermissionRequest
      if (input.blockerTerminals?.has("permission", input.directory, permission.sessionID, permission.id)) break
      const permissions = input.store.permission[permission.sessionID]
      if (!permissions) {
        input.setStore("permission", permission.sessionID, [permission])
        break
      }
      const result = Binary.search(permissions, permission.id, (p) => p.id)
      if (result.found) {
        input.setStore("permission", permission.sessionID, result.index, reconcile(permission))
        break
      }
      input.setStore(
        "permission",
        permission.sessionID,
        produce((draft) => {
          draft.splice(result.index, 0, permission)
        }),
      )
      break
    }
    case "permission.replied": {
      const props = event.properties as { sessionID: string; requestID: string }
      input.blockerTerminals?.mark("permission", input.directory, props.sessionID, props.requestID)
      const permissions = input.store.permission[props.sessionID]
      if (!permissions) break
      const result = Binary.search(permissions, props.requestID, (p) => p.id)
      if (!result.found) break
      input.setStore(
        "permission",
        props.sessionID,
        produce((draft) => {
          draft.splice(result.index, 1)
        }),
      )
      break
    }
    case "lsp.updated": {
      input.loadLsp()
      break
    }
  }
}
