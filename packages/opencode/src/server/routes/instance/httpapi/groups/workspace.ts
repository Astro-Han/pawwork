import { WorkspaceID } from "@/control-plane/schema"
import { ProjectID } from "@/project/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { BadRequestError, WorkspaceRoutingQuery } from "./common"

const root = "/experimental/workspace"

const WorkspaceInfo = Schema.Struct({
  id: WorkspaceID,
  type: Schema.String,
  branch: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  directory: Schema.NullOr(Schema.String),
  extra: Schema.NullOr(Schema.Unknown),
  projectID: ProjectID,
})

const WorkspaceConnectionStatus = Schema.Struct({
  workspaceID: WorkspaceID,
  status: Schema.Literals(["connected", "connecting", "disconnected", "error"]),
  error: Schema.optional(Schema.String),
})

const WorkspaceCreatePayload = Schema.Struct({
  id: Schema.optional(WorkspaceID),
  type: Schema.String,
  branch: Schema.NullOr(Schema.String),
  extra: Schema.NullOr(Schema.Unknown),
})

const WorkspaceIDParam = Schema.Struct({
  id: WorkspaceID,
})

export const WorkspacePaths = {
  list: root,
  status: `${root}/status`,
  remove: `${root}/:id`,
} as const

export const WorkspaceApi = HttpApi.make("workspace")
  .add(
    HttpApiGroup.make("workspace")
      .add(
        HttpApiEndpoint.post("create", WorkspacePaths.list, {
          query: WorkspaceRoutingQuery,
          payload: WorkspaceCreatePayload,
          success: WorkspaceInfo,
          error: BadRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.workspace.create",
            summary: "Create workspace",
            description: "Create a workspace for the current project.",
          }),
        ),
        HttpApiEndpoint.get("list", WorkspacePaths.list, {
          query: WorkspaceRoutingQuery,
          success: Schema.Array(WorkspaceInfo),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.workspace.list",
            summary: "List workspaces",
            description: "List all workspaces.",
          }),
        ),
        HttpApiEndpoint.get("status", WorkspacePaths.status, {
          query: WorkspaceRoutingQuery,
          success: Schema.Array(WorkspaceConnectionStatus),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.workspace.status",
            summary: "Workspace status",
            description: "Get connection status for workspaces in the current project.",
          }),
        ),
        HttpApiEndpoint.delete("remove", WorkspacePaths.remove, {
          params: WorkspaceIDParam,
          query: WorkspaceRoutingQuery,
          success: Schema.UndefinedOr(WorkspaceInfo),
          error: BadRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.workspace.remove",
            summary: "Remove workspace",
            description: "Remove an existing workspace.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "workspace",
          description: "HttpApi experimental workspace routes.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode workspace HttpApi",
      version: "0.0.1",
      description: "HttpApi surface for the experimental workspace route group.",
    }),
  )
