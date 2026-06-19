import { PermissionID } from "@/permission/schema"
import { MessageID, SessionID } from "@/session/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { BadRequestError, NotFoundError, WorkspaceRoutingQuery } from "./common"

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

const E2EPermissionAskPayload = Schema.Struct({
  sessionID: SessionID,
  permission: Schema.String,
  patterns: Schema.Array(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  always: Schema.optional(Schema.Array(Schema.String)),
})

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
          error: [BadRequestError, NotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "permission.reply",
            summary: "Respond to permission request",
            description: "Approve or deny a permission request from the AI assistant.",
          }),
        ),
        HttpApiEndpoint.post("e2eAsk", `${root}/__e2e/ask`, {
          payload: E2EPermissionAskPayload,
          success: Schema.Void,
          error: BadRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "permission.e2e.ask",
            summary: "Seed an e2e permission request",
            description: "Test-only route gated by the OPENCODE_E2E_ENABLED and OPENCODE_E2E_LLM_URL environment flags.",
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
