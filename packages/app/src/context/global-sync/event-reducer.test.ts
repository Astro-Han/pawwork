import { describe, expect, test } from "bun:test"
import type { Message, Part, PermissionRequest, Project, QuestionRequest, Session, Todo } from "@opencode-ai/sdk/v2/client"
import { createStore } from "solid-js/store"
import type { State } from "./types"
import { createBlockerTerminalCache } from "./blocker-terminal-cache"
import { applyDetachedDirectoryEvent, applyDirectoryEvent, applyGlobalEvent, cleanupDroppedSessionCaches } from "./event-reducer"

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

const permissionRequest = (id: string, sessionID: string, title = id) =>
  ({
    id,
    sessionID,
    permission: title,
    patterns: ["*"],
    metadata: {},
    always: [],
  }) as PermissionRequest

const questionRequest = (id: string, sessionID: string, title = id) =>
  ({
    id,
    sessionID,
    questions: [
      {
        question: title,
        header: title,
        options: [{ label: title, description: title }],
      },
    ],
  }) as QuestionRequest

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
    session_diff: {},
    todo: {},
    permission: {},
    question: {},
    blocker: {},
    mcp: {},
    lsp: [],
    vcs: undefined,
    limit: 10,
    message: {},
    part: {},
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
    const writes: Array<{
      sessionID: string
      todos: Todo[] | undefined
      options?: { clearActiveParts?: boolean }
    }> = []

    const handled = applyDetachedDirectoryEvent({
      event: { type: "todo.updated", properties: { sessionID: "ses_fresh", todos } },
      setSessionTodo(sessionID, value, options) {
        writes.push({ sessionID, todos: value, options })
      },
    })

    expect(handled).toBe(true)
    expect(writes).toEqual([{ sessionID: "ses_fresh", todos, options: undefined }])
  })

  test("marks detached empty todo updates as active-parts clears", () => {
    const writes: Array<{
      sessionID: string
      todos: Todo[] | undefined
      options?: { clearActiveParts?: boolean }
    }> = []

    const handled = applyDetachedDirectoryEvent({
      event: { type: "todo.updated", properties: { sessionID: "ses_clear", todos: [] } },
      setSessionTodo(sessionID, value, options) {
        writes.push({ sessionID, todos: value, options })
      },
    })

    expect(handled).toBe(true)
    expect(writes).toEqual([{ sessionID: "ses_clear", todos: [], options: { clearActiveParts: true } }])
  })

  test("marks directory empty todo updates as active-parts clears", () => {
    const [store, setStore] = createStore(baseState())
    const writes: Array<{
      sessionID: string
      todos: Todo[] | undefined
      options?: { clearActiveParts?: boolean }
    }> = []

    applyDirectoryEvent({
      event: { type: "todo.updated", properties: { sessionID: "ses_clear", todos: [] } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
      setSessionTodo(sessionID, value, options) {
        writes.push({ sessionID, todos: value, options })
      },
    })

    expect(store.todo.ses_clear).toEqual([])
    expect(writes).toEqual([{ sessionID: "ses_clear", todos: [], options: { clearActiveParts: true } }])
  })

  test("ignores detached events that need a directory child store", () => {
    const handled = applyDetachedDirectoryEvent({
      event: { type: "message.updated", properties: { info: userMessage("msg_1", "ses_1") } },
      setSessionTodo() {
        throw new Error("should not write detached todo cache")
      },
    })

    expect(handled).toBe(false)
  })

  test("ignores malformed detached todo updates", () => {
    const handled = applyDetachedDirectoryEvent({
      event: { type: "todo.updated" },
      setSessionTodo() {
        throw new Error("should not write detached todo cache")
      },
    })

    expect(handled).toBe(false)
  })

  test("clears detached todo cache for deleted and archived sessions", () => {
    const writes: Array<{ sessionID: string; todos: Todo[] | undefined }> = []
    const setSessionTodo = (sessionID: string, todos: Todo[] | undefined) => {
      writes.push({ sessionID, todos })
    }

    const deleted = applyDetachedDirectoryEvent({
      event: { type: "session.deleted", properties: { info: rootSession({ id: "ses_deleted" }) } },
      setSessionTodo,
    })
    const archived = applyDetachedDirectoryEvent({
      event: { type: "session.updated", properties: { info: rootSession({ id: "ses_archived", archived: 2 }) } },
      setSessionTodo,
    })
    const activeUpdate = applyDetachedDirectoryEvent({
      event: { type: "session.updated", properties: { info: rootSession({ id: "ses_active" }) } },
      setSessionTodo,
    })

    expect(deleted).toBe(true)
    expect(archived).toBe(true)
    expect(activeUpdate).toBe(false)
    expect(writes).toEqual([
      { sessionID: "ses_deleted", todos: undefined },
      { sessionID: "ses_archived", todos: undefined },
    ])
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
        session_diff: { ses_1: [] },
        todo: { ses_1: [] },
        permission: { ses_1: [] },
        question: { ses_1: [] },
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
    expect(store.session_diff.ses_1).toBeUndefined()
    expect(store.todo.ses_1).toBeUndefined()
    expect(store.permission.ses_1).toBeUndefined()
    expect(store.question.ses_1).toBeUndefined()
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
          session_diff: { [item.info.id]: [] },
          todo: { [item.info.id]: [] },
          permission: { [item.info.id]: [] },
          question: { [item.info.id]: [] },
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
      expect(store.session_diff[item.info.id]).toBeUndefined()
      expect(store.todo[item.info.id]).toBeUndefined()
      expect(store.permission[item.info.id]).toBeUndefined()
      expect(store.question[item.info.id]).toBeUndefined()
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
        session_diff: { [existing.id]: [] },
        todo: { [existing.id]: [] },
        permission: { [existing.id]: [] },
        question: { [existing.id]: [] },
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
      setSessionTodo(sessionID, value) {
        if (value !== undefined) return
        todos.push(sessionID)
      },
    })

    expect(store.session.map((x) => x.id)).toEqual([created.id, existing.id])
    expect(store.message[existing.id]).toEqual([message])
    expect(store.part[message.id]).toEqual([textPart("prt_1", existing.id, message.id)])
    expect(store.session_diff[existing.id]).toEqual([])
    expect(store.todo[existing.id]).toEqual([])
    expect(store.permission[existing.id]).toEqual([])
    expect(store.question[existing.id]).toEqual([])
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

  test("tracks permission and question request lifecycles", () => {
    const sessionID = "ses_1"
    const [store, setStore] = createStore(
      baseState({
        permission: { [sessionID]: [permissionRequest("perm_1", sessionID), permissionRequest("perm_3", sessionID)] },
        question: { [sessionID]: [questionRequest("q_1", sessionID), questionRequest("q_3", sessionID)] },
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

    applyDirectoryEvent({
      event: { type: "question.asked", properties: questionRequest("q_2", sessionID) },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.question[sessionID]?.map((x) => x.id)).toEqual(["q_1", "q_2", "q_3"])

    applyDirectoryEvent({
      event: { type: "question.asked", properties: questionRequest("q_2", sessionID, "updated") },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.question[sessionID]?.find((x) => x.id === "q_2")?.questions[0]?.header).toBe("updated")

    applyDirectoryEvent({
      event: { type: "question.rejected", properties: { sessionID, requestID: "q_2" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.question[sessionID]?.map((x) => x.id)).toEqual(["q_1", "q_3"])
  })

  test("question.replied before question.asked prevents stale ask from reopening", () => {
    const blockerTerminals = createBlockerTerminalCache({ now: () => 1000 })
    const [store, setStore] = createStore(baseState())

    applyDirectoryEvent({
      event: { type: "question.replied", properties: { sessionID: "ses_1", requestID: "q1" } },
      directory: "/repo",
      store,
      setStore,
      push() {},
      loadLsp() {},
      blockerTerminals,
    })

    applyDirectoryEvent({
      event: {
        type: "question.asked",
        properties: questionRequest("q1", "ses_1"),
      },
      directory: "/repo",
      store,
      setStore,
      push() {},
      loadLsp() {},
      blockerTerminals,
    })

    expect(store.question.ses_1).toBeUndefined()
  })

  test("tracks question blocker lifecycle", () => {
    const sessionID = "ses_1"
    const [store, setStore] = createStore(
      baseState({
        blocker: {
          [sessionID]: [
            {
              kind: "question",
              status: "awaiting_user",
              sessionID,
              requestID: "q_1",
              request: questionRequest("q_1", sessionID),
              armedAt: 1,
              updatedAt: 1,
            },
            {
              kind: "question",
              status: "awaiting_user",
              sessionID,
              requestID: "q_3",
              request: questionRequest("q_3", sessionID),
              armedAt: 1,
              updatedAt: 1,
            },
          ],
        },
      }),
    )

    applyDirectoryEvent({
      event: {
        type: "session.blocker.upserted",
        properties: {
          kind: "question",
          status: "awaiting_user",
          sessionID,
          requestID: "q_2",
          request: questionRequest("q_2", sessionID),
          armedAt: 1,
          updatedAt: 1,
        },
      },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.blocker[sessionID]?.map((x) => x.requestID)).toEqual(["q_1", "q_2", "q_3"])

    applyDirectoryEvent({
      event: { type: "session.blocker.removed", properties: { kind: "question", sessionID, requestID: "q_2", reason: "replied" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.blocker[sessionID]?.map((x) => x.requestID)).toEqual(["q_1", "q_3"])
  })

  test("question terminal events clear matching stale question blockers", () => {
    const sessionID = "ses_1"
    const [store, setStore] = createStore(
      baseState({
        blocker: {
          [sessionID]: [
            {
              kind: "question",
              status: "awaiting_user",
              sessionID,
              requestID: "q_1",
              request: questionRequest("q_1", sessionID),
              armedAt: 1,
              updatedAt: 1,
            },
            {
              kind: "question",
              status: "awaiting_user",
              sessionID,
              requestID: "q_2",
              request: questionRequest("q_2", sessionID),
              armedAt: 1,
              updatedAt: 1,
            },
          ],
        },
      }),
    )

    applyDirectoryEvent({
      event: { type: "question.replied", properties: { sessionID, requestID: "q_1" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.blocker[sessionID]?.map((x) => x.requestID)).toEqual(["q_2"])

    applyDirectoryEvent({
      event: { type: "question.rejected", properties: { sessionID, requestID: "q_2", reason: "dismissed" } },
      store,
      setStore,
      push() {},
      directory: "/tmp",
      loadLsp() {},
    })
    expect(store.blocker[sessionID]).toEqual([])
  })

  test("question.replied before blocker.upserted prevents stale blocker from reopening", () => {
    const blockerTerminals = createBlockerTerminalCache({ now: () => 1000 })
    const [store, setStore] = createStore(baseState())
    const sessionID = "ses_1"

    applyDirectoryEvent({
      event: { type: "question.replied", properties: { sessionID, requestID: "q1" } },
      directory: "/repo",
      store,
      setStore,
      push() {},
      loadLsp() {},
      blockerTerminals,
    })

    applyDirectoryEvent({
      event: {
        type: "session.blocker.upserted",
        properties: {
          kind: "question",
          status: "awaiting_user",
          sessionID,
          requestID: "q1",
          request: questionRequest("q1", sessionID),
          armedAt: 1,
          updatedAt: 1,
        },
      },
      directory: "/repo",
      store,
      setStore,
      push() {},
      loadLsp() {},
      blockerTerminals,
    })

    expect(store.blocker[sessionID]).toBeUndefined()
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
