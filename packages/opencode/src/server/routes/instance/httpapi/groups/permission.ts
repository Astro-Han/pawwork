import { PermissionID } from "@/permission/schema"
import { MessageID, SessionID } from "@/session/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { BadRequestError, WorkspaceRoutingQuery } from "./common"

const root = "/permission"

const PermissionRequest = Schema.Struct({
  id: PermissionID,
  sessionID: SessionID,
  permission: Schema.String,
  patterns: Schema.Array(Schema.String),
  metadata: Schema.Record(Schema.String, Schema.Any),
  always: Schema.Array(Schema.String),
  tool: Schema.optional(
    Schema.Struct({
      messageID: MessageID,
      callID: Schema.String,
    }),
  ),
})

const PermissionReplyPayload = Schema.Struct({
  reply: Schema.Literals(["once", "always", "reject"]),
  message: Schema.optional(Schema.String),
})

const PermissionReplyParam = Schema.Struct({
  requestID: PermissionID,
})

const PermissionNotFoundError = Schema.Struct({
  name: Schema.Literal("NotFoundError"),
  data: Schema.Struct({
    message: Schema.String,
  }),
}).pipe(
  HttpApiSchema.status(404),
  (schema) =>
    schema.annotate({
      identifier: "PermissionNotFoundError",
      description: "Permission request not found",
    }),
)

export const PermissionApi = HttpApi.make("permission")
  .add(
    HttpApiGroup.make("permission")
      .add(
        HttpApiEndpoint.get("list", root, {
          query: WorkspaceRoutingQuery,
          success: Schema.Array(PermissionRequest),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "permission.list",
            summary: "List pending permissions",
            description: "Get all pending permission requests across all sessions.",
          }),
        ),
        HttpApiEndpoint.post("reply", `${root}/:requestID/reply`, {
          params: PermissionReplyParam,
          query: WorkspaceRoutingQuery,
          payload: PermissionReplyPayload,
          success: Schema.Boolean,
          error: [BadRequestError, PermissionNotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "permission.reply",
            summary: "Respond to permission request",
            description: "Approve or deny a permission request from the AI assistant.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "permission",
          description: "HttpApi permission routes.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode permission HttpApi",
      version: "0.0.1",
      description: "HttpApi surface for the permission route group.",
    }),
  )
