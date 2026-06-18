import { ConsoleState } from "@/config/console-state"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { BadRequestError } from "./common"

const root = "/experimental"

const ConsoleOrgOption = Schema.Struct({
  accountID: Schema.String,
  accountEmail: Schema.String,
  accountUrl: Schema.String,
  orgID: Schema.String,
  orgName: Schema.String,
  active: Schema.Boolean,
})

const ConsoleOrgList = Schema.Struct({
  orgs: Schema.Array(ConsoleOrgOption),
})

const ConsoleSwitchPayload = Schema.Struct({
  accountID: Schema.String,
  orgID: Schema.String,
})

const ToolListQuery = Schema.Struct({
  provider: Schema.String,
  model: Schema.String,
})

const ToolListItem = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  parameters: Schema.Any,
})

const SessionListQuery = Schema.Struct({
  directory: Schema.optionalKey(Schema.String),
  roots: Schema.optionalKey(Schema.Literals(["true", "false"])),
  start: Schema.optionalKey(Schema.NumberFromString),
  cursor: Schema.optionalKey(Schema.String),
  search: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.NumberFromString),
  archived: Schema.optionalKey(Schema.Literals(["true", "false"])),
  sort: Schema.optionalKey(Schema.Literals(["updated", "created", "activity"])),
})

const McpResource = Schema.Struct({
  name: Schema.String,
  uri: Schema.String,
  description: Schema.optionalKey(Schema.String),
  mimeType: Schema.optionalKey(Schema.String),
  client: Schema.String,
})

const WorktreeInfo = Schema.Struct({
  name: Schema.String,
  branch: Schema.String,
  directory: Schema.String,
  source: Schema.optionalKey(Schema.Literals(["created", "existing"])),
})

const WorktreeCreatePayload = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  startCommand: Schema.optionalKey(Schema.String),
})

const WorktreeDirectoryPayload = Schema.Struct({
  directory: Schema.String,
})

export const ExperimentalPaths = {
  console: `${root}/console`,
  consoleOrgs: `${root}/console/orgs`,
  consoleSwitch: `${root}/console/switch`,
  tool: `${root}/tool`,
  toolIds: `${root}/tool/ids`,
  resource: `${root}/resource`,
  session: `${root}/session`,
  worktree: `${root}/worktree`,
  worktreeReset: `${root}/worktree/reset`,
} as const

export const ExperimentalApi = HttpApi.make("experimental")
  .add(
    HttpApiGroup.make("experimental")
      .add(
        HttpApiEndpoint.get("console", ExperimentalPaths.console, {
          success: ConsoleState,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.get",
            summary: "Get active Console provider metadata",
            description: "Get the active Console org name and the set of provider IDs managed by that Console org.",
          }),
        ),
        HttpApiEndpoint.get("consoleOrgs", ExperimentalPaths.consoleOrgs, {
          success: ConsoleOrgList,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.listOrgs",
            summary: "List switchable Console orgs",
            description: "Get the available Console orgs across logged-in accounts, including the current active org.",
          }),
        ),
        HttpApiEndpoint.post("consoleSwitch", ExperimentalPaths.consoleSwitch, {
          payload: ConsoleSwitchPayload,
          success: Schema.Boolean,
          error: BadRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.console.switchOrg",
            summary: "Switch active Console org",
            description: "Persist a new active Console account/org selection for the current local OpenCode state.",
          }),
        ),
        HttpApiEndpoint.get("tool", ExperimentalPaths.tool, {
          query: ToolListQuery,
          success: Schema.Array(ToolListItem),
          error: BadRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tool.list",
            summary: "List tools",
            description:
              "Get a list of available tools with their JSON schema parameters for a specific provider and model combination.",
          }),
        ),
        HttpApiEndpoint.get("toolIds", ExperimentalPaths.toolIds, {
          success: Schema.Array(Schema.String),
          error: BadRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "tool.ids",
            summary: "List tool IDs",
            description:
              "Get a list of all available tool IDs, including both built-in tools and dynamically registered tools.",
          }),
        ),
        HttpApiEndpoint.get("resource", ExperimentalPaths.resource, {
          success: Schema.Record(Schema.String, McpResource),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.resource.list",
            summary: "Get MCP resources",
            description: "Get all available MCP resources from connected servers. Optionally filter by name.",
          }),
        ),
        HttpApiEndpoint.get("session", ExperimentalPaths.session, {
          query: SessionListQuery,
          success: Schema.Array(Schema.Any),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "experimental.session.list",
            summary: "List global sessions",
            description: "List OpenCode sessions across projects with the same cursor and sort semantics as the Hono route.",
          }),
        ),
        HttpApiEndpoint.post("worktreeCreate", ExperimentalPaths.worktree, {
          payload: Schema.optional(WorktreeCreatePayload),
          success: WorktreeInfo,
          error: BadRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.create",
            summary: "Create worktree",
            description: "Create a new git worktree for the current project and run any configured startup scripts.",
          }),
        ),
        HttpApiEndpoint.get("worktreeList", ExperimentalPaths.worktree, {
          success: Schema.Array(WorktreeInfo),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.list",
            summary: "List worktrees",
            description: "List all sandbox worktrees for the current project.",
          }),
        ),
        HttpApiEndpoint.delete("worktreeRemove", ExperimentalPaths.worktree, {
          payload: WorktreeDirectoryPayload,
          success: Schema.Boolean,
          error: BadRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.remove",
            summary: "Remove worktree",
            description: "Remove a git worktree and delete its branch.",
          }),
        ),
        HttpApiEndpoint.post("worktreeReset", ExperimentalPaths.worktreeReset, {
          payload: WorktreeDirectoryPayload,
          success: Schema.Boolean,
          error: BadRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "worktree.reset",
            summary: "Reset worktree",
            description: "Reset a worktree branch to the primary default branch.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "experimental",
          description: "HttpApi experimental JSON routes.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "HttpApi surface for ordinary experimental JSON routes.",
    }),
  )
