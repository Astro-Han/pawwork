import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Todo } from "../../src/session/todo"
import { tmpdir } from "../fixture/fixture"

const todo = (content: string, id?: Todo.TodoID): Todo.Input => ({
  id,
  content,
  status: "pending",
  priority: "medium",
})

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

    expect(resolved[0].id).not.toBe(unknown)
    expect(resolved[1].id).toBe(previous[0].id)
    expect(resolved[2].id).not.toBe(previous[0].id)
  })
})

describe("Todo service", () => {
  test("update returns ids and get persists them", async () => {
    await using tmp = await tmpdir({ git: true })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({ title: "todo ids" })
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

        expect(first[0].id).toStartWith("todo_")
        expect(stored).toEqual(first)

        await Session.remove(session.id)
      },
    })
  })
})
