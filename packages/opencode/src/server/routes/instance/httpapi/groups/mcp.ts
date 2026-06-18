import { ConfigMCP } from "@/config"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { BadRequestError, WorkspaceRoutingQuery } from "./common"

const root = "/mcp"

const McpNameParam = Schema.Struct({
  name: Schema.String,
})

export const AddMcpPayload = Schema.Struct({
  name: Schema.String,
  config: ConfigMCP.Info,
})

const McpStatus = Schema.Union([
  Schema.Struct({ status: Schema.Literal("connected") }),
  Schema.Struct({ status: Schema.Literal("disabled") }),
  Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String }),
  Schema.Struct({ status: Schema.Literal("needs_auth") }),
  Schema.Struct({ status: Schema.Literal("needs_client_registration"), error: Schema.String }),
])

export const McpStatusMap = Schema.Record(Schema.String, McpStatus)

export const McpAuthStartResponse = Schema.Struct({
  authorizationUrl: Schema.String,
  oauthState: Schema.String,
})

export const McpAuthCallbackPayload = Schema.Struct({
  code: Schema.String,
})

export const McpAuthRemoveResponse = Schema.Struct({
  success: Schema.Literal(true),
})

export const McpUnsupportedOAuthError = Schema.Struct({
  error: Schema.String,
}).pipe(
  HttpApiSchema.status(400),
  (schema) =>
    schema.annotate({
      identifier: "McpUnsupportedOAuthError",
      description: "MCP server does not support OAuth",
    }),
)

export const McpApi = HttpApi.make("mcp")
  .add(
    HttpApiGroup.make("mcp")
      .add(
        HttpApiEndpoint.get("status", root, {
          query: WorkspaceRoutingQuery,
          success: McpStatusMap,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.status",
            summary: "Get MCP status",
            description: "Get the status of all Model Context Protocol (MCP) servers.",
          }),
        ),
        HttpApiEndpoint.post("add", root, {
          query: WorkspaceRoutingQuery,
          payload: AddMcpPayload,
          success: McpStatusMap,
          error: BadRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.add",
            summary: "Add MCP server",
            description: "Dynamically add a new Model Context Protocol (MCP) server to the system.",
          }),
        ),
        HttpApiEndpoint.post("authStart", `${root}/:name/auth`, {
          params: McpNameParam,
          query: WorkspaceRoutingQuery,
          success: McpAuthStartResponse,
          error: McpUnsupportedOAuthError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.auth.start",
            summary: "Start MCP OAuth",
            description: "Start OAuth authentication flow for a Model Context Protocol (MCP) server.",
          }),
        ),
        HttpApiEndpoint.post("authCallback", `${root}/:name/auth/callback`, {
          params: McpNameParam,
          query: WorkspaceRoutingQuery,
          payload: McpAuthCallbackPayload,
          success: McpStatus,
          error: BadRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.auth.callback",
            summary: "Complete MCP OAuth",
            description:
              "Complete OAuth authentication for a Model Context Protocol (MCP) server using the authorization code.",
          }),
        ),
        HttpApiEndpoint.post("authAuthenticate", `${root}/:name/auth/authenticate`, {
          params: McpNameParam,
          query: WorkspaceRoutingQuery,
          success: McpStatus,
          error: McpUnsupportedOAuthError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.auth.authenticate",
            summary: "Authenticate MCP OAuth",
            description: "Start OAuth flow and wait for callback (opens browser)",
          }),
        ),
        HttpApiEndpoint.delete("authRemove", `${root}/:name/auth`, {
          params: McpNameParam,
          query: WorkspaceRoutingQuery,
          success: McpAuthRemoveResponse,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.auth.remove",
            summary: "Remove MCP OAuth",
            description: "Remove OAuth credentials for an MCP server",
          }),
        ),
        HttpApiEndpoint.post("connect", `${root}/:name/connect`, {
          params: McpNameParam,
          query: WorkspaceRoutingQuery,
          success: Schema.Boolean,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.connect",
            description: "Connect an MCP server",
          }),
        ),
        HttpApiEndpoint.post("disconnect", `${root}/:name/disconnect`, {
          params: McpNameParam,
          query: WorkspaceRoutingQuery,
          success: Schema.Boolean,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "mcp.disconnect",
            description: "Disconnect an MCP server",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "mcp",
          description: "HttpApi MCP routes.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode mcp HttpApi",
      version: "0.0.1",
      description: "HttpApi surface for the MCP route group.",
    }),
  )
