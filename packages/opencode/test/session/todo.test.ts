import { describe, expect, spyOn, test } from "bun:test"
import { Effect } from "effect"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Todo } from "../../src/session/todo"
import { SessionID } from "../../src/session/schema"
import { Database } from "../../src/storage/db"
import { tmpdir } from "../fixture/fixture"

const todo = (content: string, id?: Todo.TodoID): Todo.Input => ({
  id,
  content,
  status: "pending",
  priority: "medium",
})
const runSession = <A>(fn: (svc: Session.Interface) => Effect.Effect<A>) => AppRuntime.runPromise(Session.Service.use(fn))

describe("resolveTodoIDs", () => {
  test("assigns ids to idless todos", () => {
    const resolved = Todo.resolveTodoIDs([], [todo("A")])

    expect(resolved[0]).toMatchObject({ content: "A", status: "pending", priority: "medium" })
    expect(resolved[0].id).toStartWith("todo_")
  })

  test("preserves existing ids carried by the input", () => {
    const previous = Todo.resolveTodoIDs([], [todo("A")])
    const resolved = Todo.resolveTodoIDs(previous, [
      { id: previous[0].id, content: "A refreshed", status: "completed", priority: "low" },
    ])

    expect(resolved[0].id).toBe(previous[0].id)
  })

  test("creates a new id when same-count and same-status input omits id", () => {
    const previous = Todo.resolveTodoIDs([], [todo("A")])
    const replacement = Todo.resolveTodoIDs(previous, [todo("B")])

    expect(replacement[0].id).not.toBe(previous[0].id)
  })

  test("ignores unknown and duplicate ids", () => {
    const previous = Todo.resolveTodoIDs([], [todo("A"), todo("B")])
    const unknown = Todo.TodoID.ascending()
    const resolved = Todo.resolveTodoIDs(previous, [
      { ...todo("unknown", unknown), status: "pending" },
      { ...todo("first reuse", previous[0].id), status: "pending" },
      { ...todo("duplicate reuse", previous[0].id), status: "pending" },
    ])
    const previousIDs = previous.map(({ id }) => id)

    expect(resolved[0].id).not.toBe(unknown)
    expect(previousIDs).not.toContain(resolved[0].id)
    expect(resolved[1].id).toBe(previous[0].id)
    expect(previousIDs).not.toContain(resolved[2].id)
  })
})

describe("Todo service", () => {
  test("update returns a revisioned snapshot and get persists it", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await runSession((svc) => svc.create({ title: "todo ids" }))
        const first = await Effect.runPromise(
          Todo.Service.use((svc) =>
            svc.update({
              sessionID: session.id,
              todos: [{ content: "A", status: "pending", priority: "medium" }],
            }),
          ).pipe(Effect.provide(Todo.defaultLayer)),
        )
        const stored = await Effect.runPromise(
          Todo.Service.use((svc) => svc.get(session.id)).pipe(Effect.provide(Todo.defaultLayer)),
        )

        expect(first.revision).toBe(1)
        expect(first.todos[0].id).toStartWith("todo_")
        expect(stored).toEqual(first)

        await runSession((svc) => svc.remove(session.id))
      },
    })
  })

  test("second update preserves id and persists status changes", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await runSession((svc) => svc.create({ title: "todo update ids" }))
        const first = await Effect.runPromise(
          Todo.Service.use((svc) =>
            svc.update({
              sessionID: session.id,
              todos: [{ content: "A", status: "pending", priority: "medium" }],
            }),
          ).pipe(Effect.provide(Todo.defaultLayer)),
        )
        const second = await Effect.runPromise(
          Todo.Service.use((svc) =>
            svc.update({
              sessionID: session.id,
              todos: [{ id: first.todos[0].id, content: "A", status: "completed", priority: "medium" }],
            }),
          ).pipe(Effect.provide(Todo.defaultLayer)),
        )
        const stored = await Effect.runPromise(
          Todo.Service.use((svc) => svc.get(session.id)).pipe(Effect.provide(Todo.defaultLayer)),
        )

        expect(second.revision).toBe(2)
        expect(second.todos[0].id).toBe(first.todos[0].id)
        expect(stored).toEqual({ revision: 2, todos: [{ ...second.todos[0], status: "completed" }] })

        await runSession((svc) => svc.remove(session.id))
      },
    })
  })

  test("empty clear bumps revision and stays authoritative", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await runSession((svc) => svc.create({ title: "todo clear" }))
        await Effect.runPromise(
          Todo.Service.use((svc) =>
            svc.update({
              sessionID: session.id,
              todos: [{ content: "A", status: "pending", priority: "medium" }],
            }),
          ).pipe(Effect.provide(Todo.defaultLayer)),
        )
        const cleared = await Effect.runPromise(
          Todo.Service.use((svc) => svc.update({ sessionID: session.id, todos: [] })).pipe(
            Effect.provide(Todo.defaultLayer),
          ),
        )
        const stored = await Effect.runPromise(
          Todo.Service.use((svc) => svc.get(session.id)).pipe(Effect.provide(Todo.defaultLayer)),
        )

        expect(cleared).toEqual({ revision: 2, todos: [] })
        expect(stored).toEqual(cleared)

        await runSession((svc) => svc.remove(session.id))
      },
    })
  })

  test("get returns rev0 empty only for known sessions that never had todos", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await runSession((svc) => svc.create({ title: "todo empty" }))
        const stored = await Effect.runPromise(
          Todo.Service.use((svc) => svc.get(session.id)).pipe(Effect.provide(Todo.defaultLayer)),
        )

        expect(stored).toEqual({ revision: 0, todos: [] })

        await runSession((svc) => svc.remove(session.id))
      },
    })
  })

  test("get reads archived sessions while update rejects them", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await runSession((svc) => svc.create({ title: "todo archived" }))
        const snapshot = await Effect.runPromise(
          Todo.Service.use((svc) =>
            svc.update({
              sessionID: session.id,
              todos: [{ content: "A", status: "pending", priority: "medium" }],
            }),
          ).pipe(Effect.provide(Todo.defaultLayer)),
        )
        await runSession((svc) => svc.setArchived({ sessionID: session.id, time: Date.now() }))

        await expect(
          Effect.runPromise(Todo.Service.use((svc) => svc.get(session.id)).pipe(Effect.provide(Todo.defaultLayer))),
        ).resolves.toEqual(snapshot)
        await expect(
          Effect.runPromise(
            Todo.Service.use((svc) => svc.update({ sessionID: session.id, todos: [] })).pipe(
              Effect.provide(Todo.defaultLayer),
            ),
          ),
        ).rejects.toThrow("NotFoundError")
      },
    })
  })

  test("update checks the active session and writes todos in one transaction", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await runSession((svc) => svc.create({ title: "todo transaction boundary" }))
        const originalTransaction = Database.transaction
        let transactionCount = 0
        const transaction = spyOn(Database, "transaction").mockImplementation(
          ((callback, options) => {
            transactionCount += 1
            return originalTransaction(callback, options)
          }) as typeof Database.transaction,
        )

        try {
          await Effect.runPromise(
            Todo.Service.use((svc) =>
              svc.update({
                sessionID: session.id,
                todos: [{ content: "A", status: "pending", priority: "medium" }],
              }),
            ).pipe(Effect.provide(Todo.defaultLayer)),
          )
        } finally {
          transaction.mockRestore()
        }

        expect(transactionCount).toBe(1)

        await runSession((svc) => svc.remove(session.id))
      },
    })
  })

  test("get rejects unknown sessions", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await expect(
          Effect.runPromise(
            Todo.Service.use((svc) => svc.get(SessionID.make("ses_missing"))).pipe(Effect.provide(Todo.defaultLayer)),
          ),
        ).rejects.toThrow("NotFoundError")
      },
    })
  })
})
