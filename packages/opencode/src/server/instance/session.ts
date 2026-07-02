import { SessionID, MessageID, PartID } from "@/session/schema"
import z from "zod"
import { Session } from "../../session"
import { MessageV2 } from "../../session/message-v2"
import { SessionPrompt } from "../../session/prompt"
import { SessionRunState } from "@/session/run-state"
import { SessionRevert } from "../../session/revert"
import { SessionShare } from "@/share/session"
import { Export } from "@/session/export"
import { ShareRuntime } from "@/share/runtime"
import { NotFoundError } from "@/storage/db"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "../../session/todo"
import { Effect } from "effect"
import { AppRuntime } from "../../effect/app-runtime"
import { Command } from "../../command"
import { Permission } from "@/permission"
import { PermissionID } from "@/permission/schema"
import { ExternalResult } from "@/tool/external-result"
import { ModelID, ProviderID } from "@/provider/schema"
import { Bus } from "../../bus"
import { NamedError } from "@opencode-ai/util/error"
import { TurnChange, type Display as TurnChangeDisplay } from "@/session/turn-change"
import { FileWatcher } from "@/file/watcher"
import { File } from "@/file"
import { LSP } from "@/lsp"
import { Env } from "@/env"

const readEnv = (key: string) => AppRuntime.runSync(Env.Service.use((env) => env.get(key)))
const e2eSessionRoutesEnabled = () => readEnv("OPENCODE_E2E_ENABLED") === "true" && !!readEnv("OPENCODE_E2E_LLM_URL")
const runSessionRoute: typeof AppRuntime.runPromise = (effect, options) => AppRuntime.runPromise(effect, options)

type SessionListQuery = {
  directory?: string
  roots?: boolean
  start?: number
  search?: string
  limit?: number
  sort?: "updated" | "created"
}
type UpdateSessionInput = {
  sessionID: SessionID
  updates: {
    title?: string
    permission?: z.infer<typeof Permission.Ruleset>
    time?: {
      archived?: number
    }
  }
}
type InitSessionInput = {
  sessionID: SessionID
  body: {
    modelID: ModelID
    providerID: ProviderID
    messageID: MessageID
  }
}
type ToolRespondValue = { kind: "dismissed" } | { kind: "submitted"; value: unknown }
type TurnChangeParams = {
  sessionID: SessionID
  messageID: MessageID
}
type AggregateTurnChangeParams = {
  sessionID: SessionID
  userMessageID: MessageID
}
type SessionMessagesInput = {
  sessionID: SessionID
  limit?: number
  before?: string
}

const listSessions = Effect.fn("SessionRoutes.list")(function* (query: SessionListQuery) {
  const session = yield* Session.Service
  return yield* session.list(query)
})

const getSessionStatus = Effect.fn("SessionRoutes.status")(function* () {
  const status = yield* SessionStatus.Service
  return yield* status.list()
})

const updateE2ETodos = Effect.fn("SessionRoutes.e2e.updateTodos")(function* (input: {
  sessionID: SessionID
  todos: z.infer<typeof Todo.Input>[]
}) {
  const todo = yield* Todo.Service
  yield* todo.update(input)
})

const getSession = Effect.fn("SessionRoutes.get")(function* (sessionID: SessionID) {
  const sessions = yield* Session.Service
  return yield* sessions.get(sessionID)
})

const listSessionChildren = Effect.fn("SessionRoutes.children")(function* (sessionID: SessionID) {
  const sessions = yield* Session.Service
  return yield* sessions.children(sessionID)
})

const getSessionTodos = Effect.fn("SessionRoutes.todo")(function* (sessionID: SessionID) {
  const todo = yield* Todo.Service
  return yield* todo.get(sessionID)
})

const createSession = Effect.fn("SessionRoutes.create")(function* (body: Parameters<SessionShare.Interface["create"]>[0]) {
  const share = yield* SessionShare.Service
  return yield* share.create(body)
})

const deleteSession = Effect.fn("SessionRoutes.delete")(function* (sessionID: SessionID) {
  const sessions = yield* Session.Service
  yield* sessions.remove(sessionID)
})

const updateSession = Effect.fn("SessionRoutes.update")(function* ({ sessionID, updates }: UpdateSessionInput) {
  const sessions = yield* Session.Service
  const current = yield* sessions.get(sessionID)

  if (updates.title !== undefined) {
    yield* sessions.setTitle({ sessionID, title: updates.title })
  }
  if (updates.permission !== undefined) {
    yield* sessions.setPermission({
      sessionID,
      permission: Permission.merge(current.permission ?? [], updates.permission),
    })
  }
  if (updates.time?.archived !== undefined) {
    yield* sessions.setArchived({ sessionID, time: updates.time.archived })
  }

  return yield* sessions.get(sessionID)
})

const initSession = Effect.fn("SessionRoutes.init")(function* ({ sessionID, body }: InitSessionInput) {
  const prompt = yield* SessionPrompt.Service
  yield* prompt.command(
    SessionPrompt.CommandInput.parse({
      sessionID,
      messageID: body.messageID,
      model: body.providerID + "/" + body.modelID,
      command: Command.Default.INIT,
      arguments: "",
    }),
  )
})

const forkSession = Effect.fn("SessionRoutes.fork")(function* (input: Parameters<Session.Interface["fork"]>[0]) {
  const sessions = yield* Session.Service
  return yield* sessions.fork(input)
})

const resolveToolResponse = Effect.fn("SessionRoutes.toolRespond.resolve")(function* (input: {
  sessionID: SessionID
  messageID: MessageID
  callID: string
  value: ToolRespondValue
}) {
  return yield* ExternalResult.resolveIfPending(input)
})

const abortSession = Effect.fn("SessionRoutes.abort")(function* (input: { sessionID: SessionID; source?: string }) {
  const prompt = yield* SessionPrompt.Service
  return yield* prompt.cancel(input.sessionID, {
    source: input.source,
  })
})

const shareSession = Effect.fn("SessionRoutes.share")(function* (sessionID: SessionID) {
  const gate = yield* ShareRuntime.CloudShareGate
  if (!gate.isEnabled()) return { enabled: false as const }
  const share = yield* SessionShare.Service
  const sessions = yield* Session.Service
  return {
    enabled: true as const,
    share: yield* share.share(sessionID),
    session: yield* sessions.get(sessionID),
  }
})

const exportSession = Effect.fn("SessionRoutes.export")(function* (sessionID: SessionID) {
  return yield* Export.session(sessionID)
})

const getSessionDiff = Effect.fn("SessionRoutes.diff")(function* (input: z.infer<typeof SessionSummary.DiffInput>) {
  const summary = yield* SessionSummary.Service
  return yield* summary.diff(input)
})

const getTurnChange = Effect.fn("SessionRoutes.turnChange")(function* (params: TurnChangeParams) {
  const turnChange = yield* TurnChange.Service
  return yield* turnChange.get(params)
})

const undoTurnChange = Effect.fn("SessionRoutes.turnChange.undo")(function* (params: TurnChangeParams) {
  const state = yield* SessionRunState.Service
  const turnChange = yield* TurnChange.Service
  yield* state.assertNotBusy(params.sessionID)
  const result = yield* turnChange.undo(params)
  if (result.status === "applied") yield* publishTurnChangeFiles(result.display, "undo")
  return result
})

const redoTurnChange = Effect.fn("SessionRoutes.turnChange.redo")(function* (params: TurnChangeParams) {
  const state = yield* SessionRunState.Service
  const turnChange = yield* TurnChange.Service
  yield* state.assertNotBusy(params.sessionID)
  const result = yield* turnChange.redo(params)
  if (result.status === "applied") yield* publishTurnChangeFiles(result.display, "redo")
  return result
})

const getAggregateTurnChanges = Effect.fn("SessionRoutes.turnChanges.aggregate")(function* (
  params: AggregateTurnChangeParams,
) {
  const turnChange = yield* TurnChange.Service
  return yield* turnChange.aggregateTurnUnion(params)
})

const undoAggregateTurnChanges = Effect.fn("SessionRoutes.turnChanges.undo")(function* (
  input: AggregateTurnChangeParams & { force?: boolean },
) {
  const state = yield* SessionRunState.Service
  const turnChange = yield* TurnChange.Service
  yield* state.assertNotBusy(input.sessionID)
  const result = yield* turnChange.aggregateTurnUndo(input)
  if (result.status === "applied") yield* publishTurnChangeFiles(result.display, "undo", result.mutatedPaths)
  return result
})

const redoAggregateTurnChanges = Effect.fn("SessionRoutes.turnChanges.redo")(function* (
  input: AggregateTurnChangeParams & { force?: boolean },
) {
  const state = yield* SessionRunState.Service
  const turnChange = yield* TurnChange.Service
  yield* state.assertNotBusy(input.sessionID)
  const result = yield* turnChange.aggregateTurnRedo(input)
  if (result.status === "applied") yield* publishTurnChangeFiles(result.display, "redo", result.mutatedPaths)
  return result
})

const listSessionArtifacts = Effect.fn("SessionRoutes.artifacts")(function* (
  input: z.infer<typeof SessionSummary.ArtifactsInput>,
) {
  const summary = yield* SessionSummary.Service
  return yield* summary.artifacts(input)
})

const unshareSession = Effect.fn("SessionRoutes.unshare")(function* (sessionID: SessionID) {
  const gate = yield* ShareRuntime.CloudShareGate
  if (!gate.isEnabled()) return { enabled: false as const }
  const share = yield* SessionShare.Service
  const sessions = yield* Session.Service
  yield* share.unshare(sessionID)
  return {
    enabled: true as const,
    session: yield* sessions.get(sessionID),
  }
})

const summarizeSession = Effect.fn("SessionRoutes.summarize")(function* (
  input: {
    sessionID: SessionID
  } & z.infer<typeof SessionPrompt.LoopInput>["prelude"],
) {
  const prompt = yield* SessionPrompt.Service
  yield* prompt.loop(
    SessionPrompt.LoopInput.parse({
      sessionID: input.sessionID,
      prelude: {
        type: "compaction",
        model: input.model,
        auto: input.auto,
      },
    }),
  )

  const sessions = yield* Session.Service
  const finalMsgs = yield* sessions.messages({ sessionID: input.sessionID })
  for (let i = finalMsgs.length - 1; i >= 0; i--) {
    const info = finalMsgs[i].info
    if (info.role !== "assistant" || info.mode !== "compaction") continue
    if (info.error && info.error.name !== "MessageAbortedError") {
      const raw = (info.error.data as { message?: unknown } | undefined)?.message
      const reason =
        typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : `Compaction failed (${info.error.name})`
      return yield* Effect.fail(new NamedError.Unknown({ message: reason }))
    }
    break
  }
})

const listSessionMessages = Effect.fn("SessionRoutes.messages")(function* (input: SessionMessagesInput) {
  const sessions = yield* Session.Service
  if (input.limit === undefined || input.limit === 0) {
    yield* sessions.get(input.sessionID)
    return {
      kind: "all" as const,
      items: yield* sessions.messages({ sessionID: input.sessionID }),
    }
  }

  return {
    kind: "page" as const,
    page: yield* sessions.messagesPage({
      sessionID: input.sessionID,
      limit: input.limit,
      before: input.before,
    }),
  }
})

const deleteSessionMessage = Effect.fn("SessionRoutes.message.delete")(function* (params: {
  sessionID: SessionID
  messageID: MessageID
}) {
  const state = yield* SessionRunState.Service
  const session = yield* Session.Service
  yield* state.assertNotBusy(params.sessionID)
  yield* session.removeMessage(params)
})

const deleteSessionPart = Effect.fn("SessionRoutes.part.delete")(function* (params: {
  sessionID: SessionID
  messageID: MessageID
  partID: PartID
}) {
  const sessions = yield* Session.Service
  // Surface the route's declared 404 instead of silently succeeding:
  // deleting a part that does not exist is a not-found, not a no-op.
  // The check lives in the route, not Session.removePart, because
  // removePart is also called internally by the message processor,
  // which must stay a tolerant no-op for an already-gone part.
  const part = yield* sessions.getPart(params)
  if (!part) return yield* Effect.fail(new NotFoundError({ message: `Part not found: ${params.partID}` }))
  yield* sessions.removePart(params)
})

const updateSessionPart = Effect.fn("SessionRoutes.part.update")(function* (part: MessageV2.Part) {
  const sessions = yield* Session.Service
  return yield* sessions.updatePart(part)
})

const promptSession = Effect.fn("SessionRoutes.prompt")(function* (input: SessionPrompt.PromptInput) {
  const prompt = yield* SessionPrompt.Service
  // HTTP callers cannot mark their own messages as automation-sent.
  return yield* prompt.prompt(SessionPrompt.PromptInput.parse({ ...input, automationID: undefined }))
})

const runSessionCommand = Effect.fn("SessionRoutes.command")(function* (input: SessionPrompt.CommandInput) {
  const prompt = yield* SessionPrompt.Service
  return yield* prompt.command(SessionPrompt.CommandInput.parse(input))
})

const runSessionShell = Effect.fn("SessionRoutes.shell")(function* (input: SessionPrompt.ShellInput) {
  const prompt = yield* SessionPrompt.Service
  return yield* prompt.shell(SessionPrompt.ShellInput.parse(input))
})

const revertSession = Effect.fn("SessionRoutes.revert")(function* (input: SessionRevert.RevertInput) {
  const revert = yield* SessionRevert.Service
  return yield* revert.revert(SessionRevert.RevertInput.parse(input))
})

const unrevertSession = Effect.fn("SessionRoutes.unrevert")(function* (sessionID: SessionID) {
  const revert = yield* SessionRevert.Service
  return yield* revert.unrevert(SessionRevert.UnrevertInput.parse({ sessionID }))
})

const replyToDeprecatedPermission = Effect.fn("SessionRoutes.permission.reply")(function* (input: {
  permissionID: PermissionID
  reply: z.infer<typeof Permission.Reply>
}) {
  const permission = yield* Permission.Service
  yield* permission.reply({
    requestID: input.permissionID,
    reply: input.reply,
  })
})

function publishTurnChangeFiles(display: TurnChangeDisplay, mode: "undo" | "redo", mutatedPaths?: string[]) {
  return Effect.gen(function* () {
    const bus = yield* Bus.Service
    const lsp = yield* LSP.Service
    const allowed = mutatedPaths ? new Set(mutatedPaths) : undefined
    for (const file of display.files) {
      if (!file.openPath) continue
      if (allowed && !allowed.has(file.openPath)) continue
      const event =
        mode === "redo"
          ? file.status === "added"
            ? "add"
            : file.status === "deleted"
              ? "unlink"
              : "change"
          : file.status === "added"
            ? "unlink"
            : file.status === "deleted"
              ? "add"
              : "change"
      if (event !== "unlink") yield* bus.publish(File.Event.Edited, { file: file.openPath })
      yield* bus.publish(FileWatcher.Event.Updated, { file: file.openPath, event })
      if (event !== "unlink") yield* lsp.touchFile(file.openPath, true)
    }
  })
}

export const SessionRouteEffects = {
  listSessions,
  getSessionStatus,
  updateE2ETodos,
  e2eSessionRoutesEnabled,
  getSession,
  listSessionChildren,
  getSessionTodos,
  createSession,
  deleteSession,
  updateSession,
  initSession,
  forkSession,
  resolveToolResponse,
  abortSession,
  shareSession,
  exportSession,
  getSessionDiff,
  getTurnChange,
  undoTurnChange,
  redoTurnChange,
  getAggregateTurnChanges,
  undoAggregateTurnChanges,
  redoAggregateTurnChanges,
  listSessionArtifacts,
  unshareSession,
  summarizeSession,
  listSessionMessages,
  deleteSessionMessage,
  deleteSessionPart,
  updateSessionPart,
  promptSession,
  runSessionCommand,
  runSessionShell,
  revertSession,
  unrevertSession,
  replyToDeprecatedPermission,
} as const
