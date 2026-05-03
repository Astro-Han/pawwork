import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { SessionID, TodoID as TodoIDSchema } from "./schema"
import type { TodoID as TodoIDType } from "./schema"
import { Effect, Layer, Context } from "effect"
import z from "zod"
import { Database, eq, asc } from "../storage/db"
import { TodoTable } from "./session.sql"

export const TodoID = TodoIDSchema
export type TodoID = TodoIDType

export const Input = z.object({
  id: z.string().optional(),
  content: z.string().describe("Brief description of the task"),
  status: z.string().describe("Current status of the task: pending, in_progress, completed, cancelled"),
  priority: z.string().describe("Priority level of the task: high, medium, low"),
})
export type Input = z.infer<typeof Input>

export const Info = Input.extend({
  id: TodoIDSchema.zod,
}).meta({ ref: "Todo" })
export type Info = z.infer<typeof Info>

export const Event = {
  Updated: BusEvent.define(
    "todo.updated",
    z.object({
      sessionID: SessionID.zod,
      todos: z.array(Info),
    }),
  ),
}

export interface Interface {
  readonly update: (input: { sessionID: SessionID; todos: Input[] }) => Effect.Effect<Info[]>
  readonly get: (sessionID: SessionID) => Effect.Effect<Info[]>
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

    const update = Effect.fn("Todo.update")(function* (input: { sessionID: SessionID; todos: Input[] }) {
      const previous = yield* get(input.sessionID)
      const resolved = resolveTodoIDs(previous, input.todos)

      yield* Effect.sync(() =>
        Database.transaction((db) => {
          db.delete(TodoTable).where(eq(TodoTable.session_id, input.sessionID)).run()
          if (resolved.length === 0) return
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
        }),
      )
      yield* bus.publish(Event.Updated, { sessionID: input.sessionID, todos: resolved })
      return resolved
    })

    const get = Effect.fn("Todo.get")(function* (sessionID: SessionID) {
      const rows = yield* Effect.sync(() =>
        Database.use((db) =>
          db.select().from(TodoTable).where(eq(TodoTable.session_id, sessionID)).orderBy(asc(TodoTable.position)).all(),
        ),
      )
      return rows.map((row) => ({
        id: row.id,
        content: row.content,
        status: row.status,
        priority: row.priority,
      }))
    })

    return Service.of({ update, get })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as Todo from "./todo"
