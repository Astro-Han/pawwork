import { describe, expect, test } from "bun:test"
import type {
  AutomationDefinition,
  Message,
  Part,
  PermissionRequest,
  Project,
  Session,
  SessionDiffResponse,
  Todo,
  TodoSnapshot,
} from "@opencode-ai/sdk/v2/client"
import { createStore } from "solid-js/store"
import type { State } from "./types"
import { createBlockerTerminalCache } from "./blocker-terminal-cache"
import {
  applyDetachedDirectoryEvent,
  applyDirectoryEvent,
  applyGlobalEvent,
  cleanupDroppedSessionCaches,
} from "./event-reducer"

const rootSession = (input: { id: string; parentID?: string; archived?: number; created?: number; updated?: number }) =>
  ({
    id: input.id,
    parentID: input.parentID,
    time: {
      created: input.created ?? 1,
      updated: input.updated ?? input.created ?? 1,
      archived: input.archived,
    },
  }) as Session

const userMessage = (id: string, sessionID: string) =>
  ({
    id,
    sessionID,
    role: "user",
    time: { created: 1 },
    agent: "assistant",
    model: { providerID: "openai", modelID: "gpt" },
  }) as Message

const textPart = (id: string, sessionID: string, messageID: string) =>
  ({
    id,
    sessionID,
    messageID,
    type: "text",
    text: id,
  }) as Part

const todoToolPart = (id: string, sessionID: string, messageID: string, metadata: unknown) =>
  ({
    id,
    sessionID,
    messageID,
    type: "tool",
    callID: `call_${id}`,
    tool: "todowrite",
    state: {
      status: "completed",
      input: {},
      output: "",
      title: "",
      metadata,
      time: { start: 1, end: 1 },
    },
  }) as Part

const questionToolPart = (
  id: string,
  sessionID: string,
  messageID: string,
  status: "running" | "completed" | "error" = "running",
) =>
  ({
    id,
    sessionID,
    messageID,
    type: "tool",
    callID: `call_${id}`,
    tool: "question",
    state: {
      status,
      input: { questions: [{ header: "Question", question: "Continue?", options: [] }] },
      title: "",
      metadata: { externalResultReady: true },
      time: { start: 1 },
    },
  }) as Part

const permissionRequest = (id: string, sessionID: string, title = id) =>
  ({
    id,
    sessionID,
    permission: title,
    patterns: ["*"],
    metadata: {},
    always: [],
  }) as PermissionRequest

const emptyAggregate = (sessionID: string): SessionDiffResponse => ({ kind: "empty", sessionID })

const recurringAutomation = (input: { id: string; revision: number; failureStreak: number }) =>
  ({
    kind: "recurring",
    id: input.id,
    title: `Auto ${input.id}`,
    prompt: "do things",
    revision: input.revision,
    paused: false,
    context: "fresh",
    where: { projectID: "proj" },
    createdAt: 1,
    updatedAt: 1,
    timezone: "UTC",
    normalizationWarnings: [],
    model: { providerID: "opencode", modelID: "big-pickle" },
    rhythm: { kind: "cron", expression: "0 9 * * *" },
    stop: { kind: "never" },
    nextFireAt: null,
    nextFires: [],
    failureStreak: input.failureStreak,
  }) as AutomationDefinition

const baseState = (input: Partial<State> = {}) =>
  ({
    status: "complete",
    agent: [],
    command: [],
    command_ready: true,
    project: "",
    projectMeta: undefined,
    icon: undefined,
    provider: {} as State["provider"],
    config: {} as State["config"],
    path: { directory: "/tmp" } as State["path"],
    session: [],
    sessionTotal: 0,
    session_status: {},
    session_status_state: "ready",
    session_status_ready: true,
    turn_change_aggregate: {},
    todo: {},
    permission: {},
    external_result_question: {},
    mcp: {},
    lsp: [],
    vcs: undefined,
    limit: 10,
    message: {},
    part: {},
    automation: {},
    automation_run: {},
    automation_tombstone: {},
    ...input,
  }) as State

describe("applyGlobalEvent", () => {
  test("upserts project.updated in sorted position", () => {
    const project = [{ id: "a" }, { id: "c" }] as Project[]
    let refreshCount = 0
    applyGlobalEvent({
      event: { type: "project.updated", properties: { id: "b" } },
      project,
      refresh: () => {
        refreshCount += 1
      },
      setGlobalProject(next) {
        if (typeof next === "function") next(project)
      },
    })

    expect(project.map((x) => x.id)).toEqual(["a", "b", "c"])
    expect(refreshCount).toBe(0)
  })

  test("handles global.disposed by triggering refresh", () => {
    let refreshCount = 0
    applyGlobalEvent({
      event: { type: "global.disposed" },
      project: [],
      refresh: () => {
        refreshCount += 1
      },
      setGlobalProject() {},
    })

    expect(refreshCount).toBe(1)
  })

  test("handles server.connected by triggering refresh", () => {
    let refreshCount = 0
    applyGlobalEvent({
      event: { type: "server.connected" },
      project: [],
      refresh: () => {
        refreshCount += 1
      },
      setGlobalProject() {},
    })

    expect(refreshCount).toBe(1)
  })
})

describe("applyDirectoryEvent", () => {
  test("caches detached todo updates before a directory child store exists", () => {
    const todos: Todo[] = [{ id: "todo_1", content: "fresh todo", status: "in_progress", priority: "high" } as Todo]
    const writes: Array<{ sessionID: string; snapshot: TodoSnapshot }> = []

    const handled = applyDetachedDirectoryEvent({
      directory: "/tmp",
      event: { type: "todo.updated", properties: { sessionID: "ses_fresh", revision: 2, todos } },
      acceptSessionTodo(sessionID, snapshot) {
        writes.push({ sessionID, snapshot })
        return true
      },
      todoHydrate: { canAcceptLiveTodo: () => true },
    })

    expect(handled).toBe(true)
    expect(writes).toEqual([{ sessionID: "ses_fresh", snapshot: { revision: 2, todos } }])
  })

  test("rejects detached todo updates when live writes are fenced", () => {
    const writes: TodoSnapshot[] = []

    const handled = applyDetachedDirectoryEvent({
      directory: "/tmp",
      event: { type: "todo.updated", properties: { sessionID: "ses_clear", revision: 3, todos: [] } },
      acceptSessionTodo(_sessionID, snapshot) {
        writes.push(snapshot)
        return true
      },
      todoHydrate: { canAcceptLiveTodo: () => false },
    })

    expect(handled).toBe(true)
    expect(writes).toEqual([])
  })

  test("directory todo updates mirror only accepted snapshots", () => {
    const [store, setStore] = createStore(baseState())
    const writes: TodoSnapshot[] = []

    applyDirectoryEvent({
      event: { type: "todo.updated", properties: { sessionID: "ses_clear", revision: 4, todos: [] } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
      acceptSessionTodo(_sessionID, snapshot) {
        writes.push(snapshot)
        return true
      },
      todoHydrate: { canAcceptLiveTodo: () => true },
    })

    expect(store.todo.ses_clear).toEqual([])
    expect(writes).toEqual([{ revision: 4, todos: [] }])
  })

  test("ignores detached events that need a directory child store", () => {
    const handled = applyDetachedDirectoryEvent({
      directory: "/tmp",
      event: { type: "message.updated", properties: { info: userMessage("msg_1", "ses_1") } },
      acceptSessionTodo() {
        throw new Error("should not write detached todo cache")
      },
    })

    expect(handled).toBe(false)
  })

  test("ignores malformed detached todo updates", () => {
    const handled = applyDetachedDirectoryEvent({
      directory: "/tmp",
      event: { type: "todo.updated" },
      acceptSessionTodo() {
        throw new Error("should not write detached todo cache")
      },
    })

    expect(handled).toBe(false)
  })

  test("clears and invalidates detached todo cache for deleted and archived sessions", () => {
    const clears: string[] = []
    const invalidated: string[] = []
    const clearSessionTodoAuthoritative = (sessionID: string) => {
      clears.push(sessionID)
    }

    const deleted = applyDetachedDirectoryEvent({
      directory: "/tmp",
      event: { type: "session.deleted", properties: { info: rootSession({ id: "ses_deleted" }) } },
      clearSessionTodoAuthoritative,
      todoHydrate: { invalidateSession: (sessionID: string) => invalidated.push(sessionID) },
    })
    const archived = applyDetachedDirectoryEvent({
      directory: "/tmp",
      event: { type: "session.updated", properties: { info: rootSession({ id: "ses_archived", archived: 2 }) } },
      clearSessionTodoAuthoritative,
      todoHydrate: { invalidateSession: (sessionID: string) => invalidated.push(sessionID) },
    })
    const activeUpdate = applyDetachedDirectoryEvent({
      directory: "/tmp",
      event: { type: "session.updated", properties: { info: rootSession({ id: "ses_active" }) } },
      clearSessionTodoAuthoritative,
      todoHydrate: { invalidateSession: (sessionID: string) => invalidated.push(sessionID) },
    })

    expect(deleted).toBe(true)
    expect(archived).toBe(true)
    expect(activeUpdate).toBe(false)
    expect(clears).toEqual(["ses_deleted", "ses_archived"])
    expect(invalidated).toEqual(["ses_deleted", "ses_archived"])
  })

  test("inserts root sessions in sorted order and updates sessionTotal", () => {
    const [store, setStore] = createStore(
      baseState({
        session: [rootSession({ id: "b" })],
        sessionTotal: 1,
      }),
    )

    applyDirectoryEvent({
      event: { type: "session.created", properties: { info: rootSession({ id: "a" }) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.session.map((x) => x.id)).toEqual(["a", "b"])
    expect(store.sessionTotal).toBe(2)

    applyDirectoryEvent({
      event: { type: "session.created", properties: { info: rootSession({ id: "c", parentID: "a" }) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.sessionTotal).toBe(2)
  })

  test("cleans session caches when archived", () => {
    const message = userMessage("msg_1", "ses_1")
    const [store, setStore] = createStore(
      baseState({
        session: [rootSession({ id: "ses_1" }), rootSession({ id: "ses_2" })],
        sessionTotal: 2,
        message: { ses_1: [message] },
        part: { [message.id]: [textPart("prt_1", "ses_1", message.id)] },
        turn_change_aggregate: { ses_1: emptyAggregate("ses_1") },
        todo: { ses_1: [] },
        permission: { ses_1: [] },
        external_result_question: {
          ses_1: [
            {
              id: `${message.id}:call_1`,
              sessionID: "ses_1",
              questions: [{ question: "Continue?" }],
              messageID: message.id,
              callID: "call_1",
              partID: "prt_1",
            },
          ],
        },
        session_status: { ses_1: { type: "busy" } },
      }),
    )

    applyDirectoryEvent({
      event: { type: "session.updated", properties: { info: rootSession({ id: "ses_1", archived: 10 }) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.session.map((x) => x.id)).toEqual(["ses_2"])
    expect(store.sessionTotal).toBe(1)
    expect(store.message.ses_1).toBeUndefined()
    expect(store.part[message.id]).toBeUndefined()
    expect(store.turn_change_aggregate.ses_1).toBeUndefined()
    expect(store.todo.ses_1).toBeUndefined()
    expect(store.permission.ses_1).toBeUndefined()
    expect(store.external_result_question.ses_1).toBeUndefined()
    expect(store.session_status.ses_1).toBeUndefined()
  })

  test("cleans session caches when deleted and decrements only root totals", () => {
    const cases = [
      { info: rootSession({ id: "ses_1" }), expectedTotal: 1 },
      { info: rootSession({ id: "ses_2", parentID: "ses_1" }), expectedTotal: 2 },
    ]

    for (const item of cases) {
      const message = userMessage("msg_1", item.info.id)
      const [store, setStore] = createStore(
        baseState({
          session: [
            rootSession({ id: "ses_1" }),
            rootSession({ id: "ses_2", parentID: "ses_1" }),
            rootSession({ id: "ses_3" }),
          ],
          sessionTotal: 2,
          message: { [item.info.id]: [message] },
          part: { [message.id]: [textPart("prt_1", item.info.id, message.id)] },
          turn_change_aggregate: { [item.info.id]: emptyAggregate(item.info.id) },
          todo: { [item.info.id]: [] },
          permission: { [item.info.id]: [] },
          external_result_question: {
            [item.info.id]: [
              {
                id: `${message.id}:call_1`,
                sessionID: item.info.id,
                questions: [{ question: "Continue?" }],
                messageID: message.id,
                callID: "call_1",
                partID: "prt_1",
              },
            ],
          },
          session_status: { [item.info.id]: { type: "busy" } },
        }),
      )

      applyDirectoryEvent({
        event: { type: "session.deleted", properties: { info: item.info } },
        store,
        setStore,
        push() {},
        directory: "/tmp",
        loadLsp() {},
      })

      expect(store.session.find((x) => x.id === item.info.id)).toBeUndefined()
      expect(store.sessionTotal).toBe(item.expectedTotal)
      expect(store.message[item.info.id]).toBeUndefined()
      expect(store.part[message.id]).toBeUndefined()
      expect(store.turn_change_aggregate[item.info.id]).toBeUndefined()
      expect(store.todo[item.info.id]).toBeUndefined()
      expect(store.permission[item.info.id]).toBeUndefined()
      expect(store.external_result_question[item.info.id]).toBeUndefined()
      expect(store.session_status[item.info.id]).toBeUndefined()
    }
  })

  test("keeps expanded session history stable on session.created", () => {
    const existing = rootSession({ id: "ses_b", created: 1 })
    const created = rootSession({ id: "ses_a", created: 2 })
    const message = userMessage("msg_1", existing.id)
    const todos: string[] = []
    const [store, setStore] = createStore(
      baseState({
        limit: 1,
        session: [existing],
        message: { [existing.id]: [message] },
        part: { [message.id]: [textPart("prt_1", existing.id, message.id)] },
        turn_change_aggregate: { [existing.id]: emptyAggregate(existing.id) },
        todo: { [existing.id]: [] },
        permission: { [existing.id]: [] },
        session_status: { [existing.id]: { type: "busy" } },
      }),
    )

    applyDirectoryEvent({
      event: { type: "session.created", properties: { info: created } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
      clearSessionTodoAuthoritative: (sessionID) => todos.push(sessionID),
    })

    expect(store.session.map((x) => x.id)).toEqual([created.id, existing.id])
    expect(store.message[existing.id]).toEqual([message])
    expect(store.part[message.id]).toEqual([textPart("prt_1", existing.id, message.id)])
    expect(store.turn_change_aggregate[existing.id]).toEqual(emptyAggregate(existing.id))
    expect(store.todo[existing.id]).toEqual([])
    expect(store.permission[existing.id]).toEqual([])
    expect(store.session_status[existing.id]).toEqual({ type: "busy" })
    expect(todos).toEqual([])
  })

  test("cleanupDroppedSessionCaches clears part-only orphan state", () => {
    const [store, setStore] = createStore(
      baseState({
        session: [rootSession({ id: "ses_keep" })],
        part: { msg_1: [textPart("prt_1", "ses_drop", "msg_1")] },
      }),
    )

    cleanupDroppedSessionCaches(store, setStore, store.session)

    expect(store.part.msg_1).toBeUndefined()
  })

  test("cleanupDroppedSessionCaches reports dropped sessions even without child caches", () => {
    const forgotten: string[] = []
    const keep = rootSession({ id: "ses_keep" })
    const drop = rootSession({ id: "ses_drop" })
    const [store, setStore] = createStore(baseState({ session: [keep, drop] }))

    cleanupDroppedSessionCaches(store, setStore, [keep], {
      onDropSession: (sessionID) => {
        forgotten.push(sessionID)
      },
    })

    expect(forgotten).toEqual(["ses_drop"])
  })

  test("clears cached aggregate when turn changes are invalidated", () => {
    const [store, setStore] = createStore(
      baseState({
        turn_change_aggregate: { ses_1: emptyAggregate("ses_1") },
      }),
    )

    applyDirectoryEvent({
      event: { type: "session.turn_change_invalidated", properties: { sessionID: "ses_1" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.turn_change_aggregate.ses_1).toBeUndefined()
  })

  test("upserts and removes messages while clearing orphaned parts", () => {
    const sessionID = "ses_1"
    const [store, setStore] = createStore(
      baseState({
        message: { [sessionID]: [userMessage("msg_1", sessionID), userMessage("msg_3", sessionID)] },
        part: { msg_2: [textPart("prt_1", sessionID, "msg_2")] },
      }),
    )

    applyDirectoryEvent({
      event: { type: "message.updated", properties: { info: userMessage("msg_2", sessionID) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.message[sessionID]?.map((x) => x.id)).toEqual(["msg_1", "msg_2", "msg_3"])

    applyDirectoryEvent({
      event: {
        type: "message.updated",
        properties: {
          info: {
            ...userMessage("msg_2", sessionID),
            role: "assistant",
          } as Message,
        },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.message[sessionID]?.find((x) => x.id === "msg_2")?.role).toBe("assistant")

    applyDirectoryEvent({
      event: { type: "message.removed", properties: { sessionID, messageID: "msg_2" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.message[sessionID]?.map((x) => x.id)).toEqual(["msg_1", "msg_3"])
    expect(store.part.msg_2).toBeUndefined()
  })

  test("upserts and prunes message parts", () => {
    const sessionID = "ses_1"
    const messageID = "msg_1"
    const [store, setStore] = createStore(
      baseState({
        part: { [messageID]: [textPart("prt_1", sessionID, messageID), textPart("prt_3", sessionID, messageID)] },
      }),
    )

    applyDirectoryEvent({
      event: { type: "message.part.updated", properties: { part: textPart("prt_2", sessionID, messageID) } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.part[messageID]?.map((x) => x.id)).toEqual(["prt_1", "prt_2", "prt_3"])

    applyDirectoryEvent({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            ...textPart("prt_2", sessionID, messageID),
            text: "changed",
          } as Part,
        },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    const updated = store.part[messageID]?.find((x) => x.id === "prt_2")
    expect(updated?.type).toBe("text")
    if (updated?.type === "text") expect(updated.text).toBe("changed")

    applyDirectoryEvent({
      event: { type: "message.part.removed", properties: { messageID, partID: "prt_1" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    applyDirectoryEvent({
      event: { type: "message.part.removed", properties: { messageID, partID: "prt_2" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    applyDirectoryEvent({
      event: { type: "message.part.removed", properties: { messageID, partID: "prt_3" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.part[messageID]).toBeUndefined()
  })

  test("indexes ready question parts even when the owning message row is missing", () => {
    const sessionID = "ses_1"
    const messageID = "msg_missing"
    const [store, setStore] = createStore(baseState())

    applyDirectoryEvent({
      event: {
        type: "message.part.updated",
        properties: { part: questionToolPart("prt_question", sessionID, messageID) },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })

    expect(store.external_result_question[sessionID]?.[0]).toMatchObject({
      id: "msg_missing:call_prt_question",
      sessionID,
      messageID,
      callID: "call_prt_question",
      partID: "prt_question",
    })
  })

  test("clears indexed question blockers on terminal update and part removal", () => {
    const sessionID = "ses_1"
    const messageID = "msg_missing"
    const [store, setStore] = createStore(baseState())
    const running = questionToolPart("prt_question", sessionID, messageID)

    applyDirectoryEvent({
      event: { type: "message.part.updated", properties: { part: running } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.external_result_question[sessionID]?.length).toBe(1)

    applyDirectoryEvent({
      event: {
        type: "message.part.updated",
        properties: { part: questionToolPart("prt_question", sessionID, messageID, "error") },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.external_result_question[sessionID]).toBeUndefined()

    applyDirectoryEvent({
      event: { type: "message.part.updated", properties: { part: running } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    applyDirectoryEvent({
      event: { type: "message.part.removed", properties: { messageID, partID: "prt_question" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.external_result_question[sessionID]).toBeUndefined()
  })

  test("keeps sibling question blockers from the same message when one part settles", () => {
    const sessionID = "ses_1"
    const messageID = "msg_multi_question"
    const [store, setStore] = createStore(baseState())
    const first = questionToolPart("prt_first", sessionID, messageID)
    const second = questionToolPart("prt_second", sessionID, messageID)

    applyDirectoryEvent({
      event: { type: "message.part.updated", properties: { part: first } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    applyDirectoryEvent({
      event: { type: "message.part.updated", properties: { part: second } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.external_result_question[sessionID]?.map((question) => question.partID)).toEqual([
      "prt_first",
      "prt_second",
    ])

    applyDirectoryEvent({
      event: {
        type: "message.part.updated",
        properties: { part: questionToolPart("prt_first", sessionID, messageID, "completed") },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.external_result_question[sessionID]?.map((question) => question.partID)).toEqual(["prt_second"])

    applyDirectoryEvent({
      event: { type: "message.part.removed", properties: { messageID, partID: "prt_second" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.external_result_question[sessionID]).toBeUndefined()
  })

  test("completed live todowrite metadata writes canonical todo before part storage returns", () => {
    const sessionID = "ses_1"
    const messageID = "msg_1"
    const todos: Todo[] = [{ id: "todo_1", content: "from metadata", status: "in_progress", priority: "high" } as Todo]
    const [store, setStore] = createStore(baseState())
    const writes: TodoSnapshot[] = []

    applyDirectoryEvent({
      event: {
        type: "message.part.updated",
        properties: { part: todoToolPart("prt_1", sessionID, messageID, { revision: 5, todos }) },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
      acceptSessionTodo(_sessionID, snapshot) {
        writes.push(snapshot)
        return true
      },
      todoHydrate: { canAcceptLiveTodo: () => true },
    })

    expect(writes).toEqual([{ revision: 5, todos }])
    expect(store.todo[sessionID]).toEqual(todos)
    expect(store.part[messageID]?.[0]?.id).toBe("prt_1")
  })

  test("tracks permission request lifecycle", () => {
    const sessionID = "ses_1"
    const [store, setStore] = createStore(
      baseState({
        permission: { [sessionID]: [permissionRequest("perm_1", sessionID), permissionRequest("perm_3", sessionID)] },
      }),
    )

    applyDirectoryEvent({
      event: { type: "permission.asked", properties: permissionRequest("perm_2", sessionID) },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.permission[sessionID]?.map((x) => x.id)).toEqual(["perm_1", "perm_2", "perm_3"])

    applyDirectoryEvent({
      event: { type: "permission.asked", properties: permissionRequest("perm_2", sessionID, "updated") },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.permission[sessionID]?.find((x) => x.id === "perm_2")?.permission).toBe("updated")

    applyDirectoryEvent({
      event: { type: "permission.replied", properties: { sessionID, requestID: "perm_2" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.permission[sessionID]?.map((x) => x.id)).toEqual(["perm_1", "perm_3"])
  })

  test("permission.replied before permission.asked prevents stale ask from reopening", () => {
    const blockerTerminals = createBlockerTerminalCache({ now: () => 1000 })
    const [store, setStore] = createStore(baseState())

    applyDirectoryEvent({
      event: { type: "permission.replied", properties: { sessionID: "ses_1", requestID: "perm_1" } },
      directory: "/repo",
      store,
      setStore,
      push() {},
      loadLsp() {},
      blockerTerminals,
    })

    applyDirectoryEvent({
      event: {
        type: "permission.asked",
        properties: permissionRequest("perm_1", "ses_1"),
      },
      directory: "/repo",
      store,
      setStore,
      push() {},
      loadLsp() {},
      blockerTerminals,
    })

    expect(store.permission.ses_1).toBeUndefined()
  })

  test("updates vcs branch in store and cache", () => {
    const [store, setStore] = createStore(baseState({ vcs: { branch: "main", default_branch: "main" } }))
    const [cacheStore, setCacheStore] = createStore({
      value: { branch: "main", default_branch: "main" } as State["vcs"],
    })

    applyDirectoryEvent({
      event: { type: "vcs.branch.updated", properties: { branch: "feature/test" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
      vcsCache: {
        store: cacheStore,
        setStore: setCacheStore,
        ready: () => true,
      },
    })

    expect(store.vcs).toEqual({ branch: "feature/test", default_branch: "main" })
    expect(cacheStore.value).toEqual({ branch: "feature/test", default_branch: "main" })
  })

  test("fires one failure-streak alert on the rising edge, then stays quiet", () => {
    const [store, setStore] = createStore(
      baseState({ automation: { auto_1: recurringAutomation({ id: "auto_1", revision: 1, failureStreak: 2 }) } }),
    )
    const alerts: AutomationDefinition[] = []

    applyDirectoryEvent({
      event: {
        type: "automation.definition.updated",
        properties: recurringAutomation({ id: "auto_1", revision: 2, failureStreak: 3 }),
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
      onAutomationFailureStreak: (definition) => alerts.push(definition),
    })

    applyDirectoryEvent({
      event: {
        type: "automation.definition.updated",
        properties: recurringAutomation({ id: "auto_1", revision: 3, failureStreak: 4 }),
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
      onAutomationFailureStreak: (definition) => alerts.push(definition),
    })

    expect(alerts.map((definition) => definition.id)).toEqual(["auto_1"])
    expect((store.automation.auto_1 as AutomationDefinition).revision).toBe(3)
  })

  test("stays quiet for first-seen and stale failure-streak definitions", () => {
    const [store, setStore] = createStore(
      baseState({ automation: { auto_stale: recurringAutomation({ id: "auto_stale", revision: 5, failureStreak: 3 }) } }),
    )
    const alerts: AutomationDefinition[] = []
    const onAutomationFailureStreak = (definition: AutomationDefinition) => alerts.push(definition)

    // First time we ever see this automation it is already failing: no transition
    // was witnessed (covers the bootstrap-then-replay case), so no alert.
    applyDirectoryEvent({
      event: {
        type: "automation.definition.updated",
        properties: recurringAutomation({ id: "auto_new", revision: 1, failureStreak: 3 }),
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
      onAutomationFailureStreak,
    })

    // Stale replay below the stored revision is dropped before it can alert.
    applyDirectoryEvent({
      event: {
        type: "automation.definition.updated",
        properties: recurringAutomation({ id: "auto_stale", revision: 4, failureStreak: 9 }),
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
      onAutomationFailureStreak,
    })

    expect(alerts).toEqual([])
  })

  test("routes disposal and lsp events to side-effect handlers", () => {
    const [store, setStore] = createStore(baseState())
    const pushes: string[] = []
    let lspLoads = 0

    applyDirectoryEvent({
      event: { type: "server.instance.disposed" },
      store,
      setStore,
      push(directory) {
        pushes.push(directory)
      },
      directory: "/tmp",
      loadLsp() {
        lspLoads += 1
      },
    })

    applyDirectoryEvent({
      event: { type: "lsp.updated" },
      store,
      setStore,
      push(directory) {
        pushes.push(directory)
      },
      directory: "/tmp",
      loadLsp() {
        lspLoads += 1
      },
    })

    expect(pushes).toEqual(["/tmp"])
    expect(lspLoads).toBe(1)
  })
})
