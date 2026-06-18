import { PermissionID } from "@/permission/schema"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { BadRequestError, NotFoundError, WorkspaceRoutingQuery } from "./common"

const root = "/session"

const SessionParam = Schema.Struct({
  sessionID: SessionID,
})

const MessageParam = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
})

const PartParam = Schema.Struct({
  sessionID: SessionID,
  messageID: MessageID,
  partID: PartID,
})

const PermissionParam = Schema.Struct({
  sessionID: SessionID,
  permissionID: PermissionID,
})

const QueryBoolean = Schema.Literals(["true", "false"])

const SessionListQuery = Schema.Struct({
  ...WorkspaceRoutingQuery.fields,
  roots: Schema.optionalKey(QueryBoolean),
  start: Schema.optionalKey(Schema.NumberFromString),
  search: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.NumberFromString),
  sort: Schema.optionalKey(Schema.Literals(["updated", "created"])),
})

const SessionAbortQuery = Schema.Struct({
  ...WorkspaceRoutingQuery.fields,
  source: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]{1,80}$/))),
})

const SessionDiffQuery = Schema.Struct({
  ...WorkspaceRoutingQuery.fields,
  messageID: MessageID,
})

const SessionMessagesQuery = Schema.Struct({
  ...WorkspaceRoutingQuery.fields,
  limit: Schema.optionalKey(
    Schema.NumberFromString.pipe(
      Schema.check(Schema.isInt()),
      Schema.check(Schema.isGreaterThanOrEqualTo(0)),
    ),
  ),
  before: Schema.optionalKey(Schema.String),
})

const SessionUpdatePayload = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  permission: Schema.optionalKey(Schema.Any),
  time: Schema.optionalKey(
    Schema.Struct({
      archived: Schema.optionalKey(Schema.Number),
    }),
  ),
})

const SessionInitPayload = Schema.Struct({
  modelID: Schema.String,
  providerID: Schema.String,
  messageID: MessageID,
})

const SessionSummarizePayload = Schema.Struct({
  modelID: Schema.String,
  providerID: Schema.String,
  auto: Schema.optionalKey(Schema.Boolean),
})

const SessionToolRespondPayload = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("submit"),
    messageID: MessageID,
    callID: Schema.String,
    payload: Schema.Any,
  }),
  Schema.Struct({
    kind: Schema.Literal("dismiss"),
    messageID: MessageID,
    callID: Schema.String,
  }),
])

const SessionPermissionPayload = Schema.Struct({
  response: Schema.Literals(["once", "always", "reject"]),
})

const OptionalForcePayload = Schema.optional(
  Schema.Struct({
    force: Schema.optionalKey(Schema.Boolean),
  }),
)

const GoneError = Schema.Struct({
  error: Schema.Literal("cloud_share_disabled"),
}).pipe(
  HttpApiSchema.status(410),
  (schema) =>
    schema.annotate({
      identifier: "SessionShareDisabledError",
      description: "Cloud sharing is disabled",
    }),
)

const ConflictError = Schema.Struct({
  name: Schema.String,
  data: Schema.Struct({
    message: Schema.String,
  }),
}).pipe(
  HttpApiSchema.status(409),
  (schema) =>
    schema.annotate({
      identifier: "SessionConflictError",
      description: "Session conflict",
    }),
)

const ToolRespondFailure = Schema.Struct({
  error: Schema.String,
  details: Schema.optionalKey(Schema.Any),
})

const ToolRespondNotFoundError = ToolRespondFailure.pipe(HttpApiSchema.status(404))
const ToolRespondConflictError = ToolRespondFailure.pipe(HttpApiSchema.status(409))
const ToolRespondUnprocessableError = ToolRespondFailure.pipe(HttpApiSchema.status(422))

export const SessionPaths = {
  list: root,
  create: root,
  status: `${root}/status`,
  e2eUpdateTodos: `${root}/__e2e/update-todos`,
  get: `${root}/:sessionID`,
  update: `${root}/:sessionID`,
  remove: `${root}/:sessionID`,
  children: `${root}/:sessionID/children`,
  init: `${root}/:sessionID/init`,
  messages: `${root}/:sessionID/message`,
  prompt: `${root}/:sessionID/message`,
  message: `${root}/:sessionID/message/:messageID`,
  messageRemove: `${root}/:sessionID/message/:messageID`,
  partUpdate: `${root}/:sessionID/message/:messageID/part/:partID`,
  partRemove: `${root}/:sessionID/message/:messageID/part/:partID`,
  todo: `${root}/:sessionID/todo`,
  promptAsync: `${root}/:sessionID/prompt_async`,
  abort: `${root}/:sessionID/abort`,
  command: `${root}/:sessionID/command`,
  fork: `${root}/:sessionID/fork`,
  diff: `${root}/:sessionID/diff`,
  share: `${root}/:sessionID/share`,
  unshare: `${root}/:sessionID/share`,
  summarize: `${root}/:sessionID/summarize`,
  shell: `${root}/:sessionID/shell`,
  revert: `${root}/:sessionID/revert`,
  unrevert: `${root}/:sessionID/unrevert`,
  permission: `${root}/:sessionID/permissions/:permissionID`,
  artifacts: `${root}/:sessionID/artifacts`,
  export: `${root}/:sessionID/export`,
  toolRespond: `${root}/:sessionID/tool/respond`,
  turnChange: `${root}/:sessionID/turn-change/:messageID`,
  turnChangeUndo: `${root}/:sessionID/turn-change/:messageID/undo`,
  turnChangeRedo: `${root}/:sessionID/turn-change/:messageID/redo`,
  aggregateChanges: `${root}/:sessionID/turn/:userMessageID/changes`,
  aggregateUndo: `${root}/:sessionID/turn/:userMessageID/changes/undo`,
  aggregateRedo: `${root}/:sessionID/turn/:userMessageID/changes/redo`,
} as const

export const SessionApi = HttpApi.make("session")
  .add(
    HttpApiGroup.make("session")
      .add(
        HttpApiEndpoint.get("list", SessionPaths.list, {
          query: SessionListQuery,
          success: Schema.Array(Schema.Any),
        }),
        HttpApiEndpoint.post("create", SessionPaths.create, {
          payload: Schema.optional(Schema.Any),
          success: Schema.Any,
          error: BadRequestError,
        }),
        HttpApiEndpoint.get("status", SessionPaths.status, {
          query: WorkspaceRoutingQuery,
          success: Schema.Record(Schema.String, Schema.Any),
          error: BadRequestError,
        }),
        HttpApiEndpoint.post("e2eUpdateTodos", SessionPaths.e2eUpdateTodos, {
          payload: Schema.Struct({
            sessionID: SessionID,
            todos: Schema.Array(Schema.Any),
          }),
          success: Schema.Void,
          error: [BadRequestError, NotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            summary: "Update session todos in e2e tests",
            description: "Test-only route gated by the OPENCODE_E2E_ENABLED and OPENCODE_E2E_LLM_URL environment flags.",
          }),
        ),
        HttpApiEndpoint.get("get", SessionPaths.get, {
          params: SessionParam,
          query: WorkspaceRoutingQuery,
          success: Schema.Any,
          error: [BadRequestError, NotFoundError],
        }),
        HttpApiEndpoint.patch("update", SessionPaths.update, {
          params: SessionParam,
          query: WorkspaceRoutingQuery,
          payload: SessionUpdatePayload,
          success: Schema.Any,
          error: [BadRequestError, NotFoundError],
        }),
        HttpApiEndpoint.delete("remove", SessionPaths.remove, {
          params: SessionParam,
          query: WorkspaceRoutingQuery,
          success: Schema.Boolean,
          error: [BadRequestError, NotFoundError],
        }),
        HttpApiEndpoint.get("children", SessionPaths.children, {
          params: SessionParam,
          query: WorkspaceRoutingQuery,
          success: Schema.Array(Schema.Any),
          error: [BadRequestError, NotFoundError],
        }),
        HttpApiEndpoint.post("init", SessionPaths.init, {
          params: SessionParam,
          query: WorkspaceRoutingQuery,
          payload: SessionInitPayload,
          success: Schema.Boolean,
          error: [BadRequestError, NotFoundError],
        }),
        HttpApiEndpoint.get("messages", SessionPaths.messages, {
          params: SessionParam,
          query: SessionMessagesQuery,
          success: Schema.Array(Schema.Any),
          error: [BadRequestError, NotFoundError],
        }),
        HttpApiEndpoint.post("prompt", SessionPaths.prompt, {
          params: SessionParam,
          query: WorkspaceRoutingQuery,
          payload: Schema.Any,
          success: Schema.Any,
          error: [BadRequestError, NotFoundError],
        }),
        HttpApiEndpoint.get("message", SessionPaths.message, {
          params: MessageParam,
          query: WorkspaceRoutingQuery,
          success: Schema.Any,
          error: [BadRequestError, NotFoundError],
        }),
        HttpApiEndpoint.delete("messageRemove", SessionPaths.messageRemove, {
          params: MessageParam,
          query: WorkspaceRoutingQuery,
          success: Schema.Boolean,
          error: [BadRequestError, NotFoundError, ConflictError],
        }),
        HttpApiEndpoint.patch("partUpdate", SessionPaths.partUpdate, {
          params: PartParam,
          query: WorkspaceRoutingQuery,
          payload: Schema.Any,
          success: Schema.Any,
          error: [BadRequestError, NotFoundError],
        }),
        HttpApiEndpoint.delete("partRemove", SessionPaths.partRemove, {
          params: PartParam,
          query: WorkspaceRoutingQuery,
          success: Schema.Boolean,
          error: [BadRequestError, NotFoundError],
        }),
        HttpApiEndpoint.get("todo", SessionPaths.todo, {
          params: SessionParam,
          query: WorkspaceRoutingQuery,
          success: Schema.Any,
          error: [BadRequestError, NotFoundError],
        }),
        HttpApiEndpoint.post("promptAsync", SessionPaths.promptAsync, {
          params: SessionParam,
          query: WorkspaceRoutingQuery,
          payload: Schema.Any,
          success: Schema.Void,
          error: [BadRequestError, NotFoundError],
        }),
        HttpApiEndpoint.post("abort", SessionPaths.abort, {
          params: SessionParam,
          query: SessionAbortQuery,
          success: Schema.Boolean,
          error: [BadRequestError, NotFoundError],
        }),
        HttpApiEndpoint.post("command", SessionPaths.command, {
          params: SessionParam,
          query: WorkspaceRoutingQuery,
          payload: Schema.Any,
          success: Schema.Any,
          error: [BadRequestError, NotFoundError],
        }),
        HttpApiEndpoint.post("fork", SessionPaths.fork, {
          params: SessionParam,
          query: WorkspaceRoutingQuery,
          payload: Schema.optional(Schema.Any),
          success: Schema.Any,
          error: [BadRequestError, NotFoundError],
        }),
        HttpApiEndpoint.get("diff", SessionPaths.diff, {
          params: SessionParam,
          query: SessionDiffQuery,
          success: Schema.Any,
        }),
        HttpApiEndpoint.post("share", SessionPaths.share, {
          params: SessionParam,
          query: WorkspaceRoutingQuery,
          success: Schema.Any,
          error: [BadRequestError, NotFoundError, GoneError],
        }),
        HttpApiEndpoint.delete("unshare", SessionPaths.unshare, {
          params: SessionParam,
          query: WorkspaceRoutingQuery,
          success: Schema.Any,
          error: [BadRequestError, NotFoundError, GoneError],
        }),
        HttpApiEndpoint.post("summarize", SessionPaths.summarize, {
          params: SessionParam,
          query: WorkspaceRoutingQuery,
          payload: SessionSummarizePayload,
          success: Schema.Boolean,
          error: [BadRequestError, NotFoundError, ConflictError],
        }),
        HttpApiEndpoint.post("shell", SessionPaths.shell, {
          params: SessionParam,
          query: WorkspaceRoutingQuery,
          payload: Schema.Any,
          success: Schema.Any,
          error: [BadRequestError, NotFoundError, ConflictError],
        }),
        HttpApiEndpoint.post("revert", SessionPaths.revert, {
          params: SessionParam,
          query: WorkspaceRoutingQuery,
          payload: Schema.Any,
          success: Schema.Any,
          error: [BadRequestError, NotFoundError, ConflictError],
        }),
        HttpApiEndpoint.post("unrevert", SessionPaths.unrevert, {
          params: SessionParam,
          query: WorkspaceRoutingQuery,
          success: Schema.Any,
          error: [BadRequestError, NotFoundError, ConflictError],
        }),
        HttpApiEndpoint.post("permission", SessionPaths.permission, {
          params: PermissionParam,
          query: WorkspaceRoutingQuery,
          payload: SessionPermissionPayload,
          success: Schema.Boolean,
          error: [BadRequestError, NotFoundError],
        }),
        HttpApiEndpoint.get("artifacts", SessionPaths.artifacts, {
          params: SessionParam,
          query: WorkspaceRoutingQuery,
          success: Schema.Array(Schema.Any),
        }),
        HttpApiEndpoint.get("export", SessionPaths.export, {
          params: SessionParam,
          query: WorkspaceRoutingQuery,
          success: Schema.Any,
          error: [BadRequestError, NotFoundError],
        }),
        HttpApiEndpoint.post("toolRespond", SessionPaths.toolRespond, {
          params: SessionParam,
          query: WorkspaceRoutingQuery,
          payload: SessionToolRespondPayload,
          success: Schema.Struct({ status: Schema.Literal("ok") }),
          error: [BadRequestError, ToolRespondNotFoundError, ToolRespondConflictError, ToolRespondUnprocessableError],
        }),
        HttpApiEndpoint.get("turnChange", SessionPaths.turnChange, {
          params: MessageParam,
          query: WorkspaceRoutingQuery,
          success: Schema.NullOr(Schema.Any),
          error: [BadRequestError, NotFoundError],
        }),
        HttpApiEndpoint.post("turnChangeUndo", SessionPaths.turnChangeUndo, {
          params: MessageParam,
          query: WorkspaceRoutingQuery,
          success: Schema.Any,
          error: [BadRequestError, NotFoundError, ConflictError],
        }),
        HttpApiEndpoint.post("turnChangeRedo", SessionPaths.turnChangeRedo, {
          params: MessageParam,
          query: WorkspaceRoutingQuery,
          success: Schema.Any,
          error: [BadRequestError, NotFoundError, ConflictError],
        }),
        HttpApiEndpoint.get("aggregateChanges", SessionPaths.aggregateChanges, {
          params: Schema.Struct({ sessionID: SessionID, userMessageID: MessageID }),
          query: WorkspaceRoutingQuery,
          success: Schema.Any,
          error: [BadRequestError, NotFoundError],
        }),
        HttpApiEndpoint.post("aggregateUndo", SessionPaths.aggregateUndo, {
          params: Schema.Struct({ sessionID: SessionID, userMessageID: MessageID }),
          query: WorkspaceRoutingQuery,
          payload: OptionalForcePayload,
          success: Schema.Any,
          error: [BadRequestError, NotFoundError, ConflictError],
        }),
        HttpApiEndpoint.post("aggregateRedo", SessionPaths.aggregateRedo, {
          params: Schema.Struct({ sessionID: SessionID, userMessageID: MessageID }),
          query: WorkspaceRoutingQuery,
          payload: OptionalForcePayload,
          success: Schema.Any,
          error: [BadRequestError, NotFoundError, ConflictError],
        }),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "session",
          description: "HttpApi session JSON routes.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode session HttpApi",
      version: "0.0.1",
      description: "HttpApi surface for ordinary session JSON routes.",
    }),
  )
