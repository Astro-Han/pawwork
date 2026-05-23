import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { SessionID, TodoID as TodoIDSchema } from "./schema"
import type { TodoID as TodoIDType } from "./schema"
import { Effect, Layer, Context } from "effect"
import z from "zod"
import { Database, eq, asc, sql, NotFoundError } from "../storage/db"
import { SessionTable, SessionTodoRevisionTable, TodoTable } from "./session.sql"

export const TodoID = TodoIDSchema
export type TodoID = TodoIDType

export const Input = z.object({
  id: TodoIDSchema.zod.optional(),
  content: z.string().describe("Brief description of the task"),
  status: z.string().describe("Current status of the task: pending, in_progress, completed, cancelled"),
  priority: z.string().describe("Priority level of the task: high, medium, low"),
})
export type Input = z.infer<typeof Input>

export const Info = Input.extend({
  id: TodoIDSchema.zod,
}).meta({ ref: "Todo" })
export type Info = z.infer<typeof Info>

export const Snapshot = z
  .object({
    revision: z.number().int().nonnegative(),
    todos: z.array(Info),
  })
  .meta({ ref: "TodoSnapshot" })
export type Snapshot = z.infer<typeof Snapshot>

export const Event = {
  Updated: BusEvent.define(
    "todo.updated",
    z.object({
      sessionID: SessionID.zod,
      revision: z.number().int().nonnegative(),
      todos: z.array(Info),
    }),
  ),
}

export interface Interface {
  readonly update: (input: { sessionID: SessionID; todos: Input[] }) => Effect.Effect<Snapshot>
  readonly get: (sessionID: SessionID) => Effect.Effect<Snapshot>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionTodo") {}

export function resolveTodoIDs(previous: Info[], incoming: Input[]): Info[] {
  const previousByID = new Map(previous.map((todo) => [todo.id, todo]))
  const unusedPreviousByExactContent = new Map<string, Info[]>()
  const used = new Set<TodoID>()

  for (const todo of previous) {
    const list = unusedPreviousByExactContent.get(todo.content)
    if (list) list.push(todo)
    else unusedPreviousByExactContent.set(todo.content, [todo])
  }

  return incoming.map((todo) => {
    let id: TodoID | undefined

    if (todo.id && previousByID.has(todo.id as TodoID) && !used.has(todo.id as TodoID)) {
      id = todo.id as TodoID
    }

    // Exact-content reuse is only a legacy/idless fallback. Supplied unknown or
    // duplicate ids are treated as untrusted and get fresh identity.
    if (!id && !todo.id) {
      const candidates = unusedPreviousByExactContent.get(todo.content)
      while (candidates?.length) {
        const candidate = candidates.shift()
        if (!candidate || used.has(candidate.id)) continue
        id = candidate.id
        break
      }
    }

    id ??= TodoIDSchema.ascending()
    used.add(id)

    return {
      id,
      content: todo.content,
      status: todo.status,
      priority: todo.priority,
    }
  })
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service

    const readSnapshot = (sessionID: SessionID, options?: { activeOnly?: boolean }) =>
      Effect.sync(() =>
        Database.transaction((db) => {
          const session = db
            .select({ id: SessionTable.id, archived: SessionTable.time_archived })
            .from(SessionTable)
            .where(eq(SessionTable.id, sessionID))
            .get()
          if (!session || (options?.activeOnly && session.archived !== null)) {
            throw new NotFoundError({ message: `Session not found: ${sessionID}` })
          }
          const revision = db
            .select({ revision: SessionTodoRevisionTable.revision })
            .from(SessionTodoRevisionTable)
            .where(eq(SessionTodoRevisionTable.session_id, sessionID))
            .get()
          const rows = db
            .select()
            .from(TodoTable)
            .where(eq(TodoTable.session_id, sessionID))
            .orderBy(asc(TodoTable.position))
            .all()
          const todos = rows.map((row) => ({
            id: row.id,
            content: row.content,
            status: row.status,
            priority: row.priority,
          }))
          if (revision) return { revision: revision.revision, todos }
          return { revision: todos.length > 0 ? 1 : 0, todos }
        }),
      )

    const update = Effect.fn("Todo.update")(function* (input: { sessionID: SessionID; todos: Input[] }) {
      const previous = yield* readSnapshot(input.sessionID, { activeOnly: true })
      const resolved = resolveTodoIDs(previous.todos, input.todos)

      const revision = yield* Effect.sync(() =>
        Database.transaction((db) => {
          db.delete(TodoTable).where(eq(TodoTable.session_id, input.sessionID)).run()
          if (resolved.length > 0) {
            db.insert(TodoTable)
              .values(
                resolved.map((todo, position) => ({
                  id: todo.id,
                  session_id: input.sessionID,
                  content: todo.content,
                  status: todo.status,
                  priority: todo.priority,
                  position,
                })),
              )
              .run()
          }
          const row = db
            .insert(SessionTodoRevisionTable)
            .values({
              session_id: input.sessionID,
              revision: Math.max(previous.revision + 1, 1),
            })
            .onConflictDoUpdate({
              target: SessionTodoRevisionTable.session_id,
              set: {
                revision: sql`${SessionTodoRevisionTable.revision} + 1`,
              },
            })
            .returning({ revision: SessionTodoRevisionTable.revision })
            .get()
          return row.revision
        }),
      )
      const snapshot = { revision, todos: resolved }
      yield* bus.publish(Event.Updated, { sessionID: input.sessionID, ...snapshot })
      return snapshot
    })

    const get = Effect.fn("Todo.get")(function* (sessionID: SessionID) {
      return yield* readSnapshot(sessionID)
    })

    return Service.of({ update, get })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as Todo from "./todo"
