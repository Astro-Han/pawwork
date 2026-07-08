import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { BadRequestError, WorkspaceRoutingQuery } from "./common"

const FileStatus = Schema.Literals(["added", "deleted", "modified"])

const VcsInfo = Schema.Struct({
  branch: Schema.optionalKey(Schema.String),
  default_branch: Schema.optionalKey(Schema.String),
})

const VcsFileDiff = Schema.Struct({
  file: Schema.String,
  patch: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
  status: Schema.optionalKey(FileStatus),
})

const VcsFileStatus = Schema.Struct({
  file: Schema.String,
  additions: Schema.Number,
  deletions: Schema.Number,
  status: FileStatus,
})

const VcsModeQuery = Schema.Struct({
  ...WorkspaceRoutingQuery.fields,
  mode: Schema.Literals(["git", "branch"]),
})

const VcsApplyPayload = Schema.Struct({
  patch: Schema.String,
})

const VcsApplyResult = Schema.Struct({
  applied: Schema.Boolean,
})

const VcsApplyError = Schema.Struct({
  error: Schema.Literal("vcs_apply_failed"),
  reason: Schema.Literals(["non-git", "not-clean", "too-large", "invalid-input"]),
  message: Schema.String,
}).pipe(
  HttpApiSchema.status(400),
  (schema) =>
    schema.annotate({
      identifier: "VcsApplyFailure",
      description: "VCS patch apply failure",
    }),
)

const VcsApplyTooLargeError = Schema.Struct({
  error: Schema.Literal("vcs_apply_failed"),
  reason: Schema.Literal("too-large"),
  message: Schema.String,
}).pipe(
  HttpApiSchema.status(413),
  (schema) =>
    schema.annotate({
      identifier: "VcsApplyTooLargeFailure",
      description: "VCS patch apply request is too large",
    }),
)

const VcsDiffRawTooLargeError = Schema.Struct({
  error: Schema.Literal("vcs_diff_raw_failed"),
  reason: Schema.Literal("too-large"),
  message: Schema.String,
}).pipe(
  HttpApiSchema.status(413),
  (schema) =>
    schema.annotate({
      identifier: "VcsDiffRawFailure",
      description: "Raw VCS diff is too large",
    }),
)

const CommandInfo = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Schema.Literals(["command", "mcp", "skill"])),
  template: Schema.Unknown,
  subtask: Schema.optionalKey(Schema.Boolean),
  hints: Schema.Array(Schema.String),
})

const AgentInfo = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  mode: Schema.Literals(["subagent", "primary", "all"]),
  native: Schema.optionalKey(Schema.Boolean),
  hidden: Schema.optionalKey(Schema.Boolean),
  topP: Schema.optionalKey(Schema.Number),
  temperature: Schema.optionalKey(Schema.Number),
  color: Schema.optionalKey(Schema.String),
  permission: Schema.Unknown,
  model: Schema.optionalKey(
    Schema.Struct({
      modelID: Schema.String,
      providerID: Schema.String,
    }),
  ),
  variant: Schema.optionalKey(Schema.String),
  prompt: Schema.optionalKey(Schema.String),
  options: Schema.Record(Schema.String, Schema.Unknown),
  steps: Schema.optionalKey(Schema.Number),
})

const SkillInfo = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  location: Schema.String,
  content: Schema.String,
})

const LspStatus = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  root: Schema.String,
  status: Schema.Literals(["connected", "error"]),
})

const PathInfo = Schema.Struct({
  home: Schema.String,
  state: Schema.String,
  config: Schema.String,
  skills: Schema.String,
  worktree: Schema.String,
  directory: Schema.String,
})

export const RootPaths = {
  instanceDispose: "/instance/dispose",
  path: "/path",
  vcs: "/vcs",
  vcsStatus: "/vcs/status",
  vcsDiff: "/vcs/diff",
  vcsDiffRaw: "/vcs/diff/raw",
  vcsApply: "/vcs/apply",
  command: "/command",
  agent: "/agent",
  skill: "/skill",
  lsp: "/lsp",
} as const

export const RootApi = HttpApi.make("root")
  .add(
    HttpApiGroup.make("root")
      .add(
        HttpApiEndpoint.post("instanceDispose", RootPaths.instanceDispose, {
          query: WorkspaceRoutingQuery,
          success: Schema.Boolean,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "instance.dispose",
            summary: "Dispose instance",
            description: "Clean up and dispose the current OpenCode instance, releasing all resources.",
          }),
        ),
        HttpApiEndpoint.get("path", RootPaths.path, {
          query: Schema.Struct({
            ...WorkspaceRoutingQuery.fields,
            ensureConfig: Schema.optionalKey(Schema.Literals(["true", "false"])),
            ensureSkills: Schema.optionalKey(Schema.Literals(["true", "false"])),
          }),
          success: PathInfo,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "path.get",
            summary: "Get paths",
            description: "Retrieve the current working directory and related path information for the OpenCode instance.",
          }),
        ),
        HttpApiEndpoint.get("vcs", RootPaths.vcs, {
          query: WorkspaceRoutingQuery,
          success: VcsInfo,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.get",
            summary: "Get VCS info",
            description: "Retrieve version control system information for the current project.",
          }),
        ),
        HttpApiEndpoint.get("vcsStatus", RootPaths.vcsStatus, {
          query: WorkspaceRoutingQuery,
          success: Schema.Array(VcsFileStatus),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.status",
            summary: "Get VCS status",
            description: "Retrieve working tree file status summaries for the current project.",
          }),
        ),
        HttpApiEndpoint.get("vcsDiff", RootPaths.vcsDiff, {
          query: VcsModeQuery,
          success: Schema.Array(VcsFileDiff),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.diff",
            summary: "Get VCS diff",
            description: "Retrieve the current working-tree diff.",
          }),
        ),
        HttpApiEndpoint.get("vcsDiffRaw", RootPaths.vcsDiffRaw, {
          query: WorkspaceRoutingQuery,
          success: Schema.String,
          error: VcsDiffRawTooLargeError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.diffRaw",
            summary: "Get raw VCS diff",
            description: "Retrieve the current git diff as raw patch text.",
          }),
        ),
        HttpApiEndpoint.post("vcsApply", RootPaths.vcsApply, {
          query: WorkspaceRoutingQuery,
          payload: VcsApplyPayload,
          success: VcsApplyResult,
          error: [BadRequestError, VcsApplyError, VcsApplyTooLargeError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "vcs.apply",
            summary: "Apply VCS patch",
            description: "Apply a git patch to the current project.",
          }),
        ),
        HttpApiEndpoint.get("command", RootPaths.command, {
          query: WorkspaceRoutingQuery,
          success: Schema.Array(CommandInfo),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "command.list",
            summary: "List commands",
            description: "Get a list of all available commands in the OpenCode system.",
          }),
        ),
        HttpApiEndpoint.get("agent", RootPaths.agent, {
          query: WorkspaceRoutingQuery,
          success: Schema.Array(AgentInfo),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "app.agents",
            summary: "List agents",
            description: "Get a list of all available AI agents in the OpenCode system.",
          }),
        ),
        HttpApiEndpoint.get("skill", RootPaths.skill, {
          query: WorkspaceRoutingQuery,
          success: Schema.Array(SkillInfo),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "app.skills",
            summary: "List skills",
            description: "Get a list of all available skills in the OpenCode system.",
          }),
        ),
        HttpApiEndpoint.get("lsp", RootPaths.lsp, {
          query: WorkspaceRoutingQuery,
          success: Schema.Array(LspStatus),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "lsp.status",
            summary: "Get LSP status",
            description: "Get LSP server status.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "root",
          description: "HttpApi root instance routes.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode root instance HttpApi",
      version: "0.0.1",
      description: "HttpApi surface for root instance routes.",
    }),
  )
