import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { BadRequestError, NotFoundError, WorkspaceRoutingQuery } from "./common"

const ProjectIDParam = Schema.Struct({
  projectID: Schema.String,
})

const ProjectIcon = Schema.Struct({
  url: Schema.optionalKey(Schema.String),
  override: Schema.optionalKey(Schema.String),
  color: Schema.optionalKey(Schema.String),
})

const ProjectCommands = Schema.Struct({
  start: Schema.optionalKey(Schema.String),
})

const ProjectInfo = Schema.Struct({
  id: Schema.String,
  worktree: Schema.String,
  vcs: Schema.optionalKey(Schema.Literal("git")),
  name: Schema.optionalKey(Schema.String),
  icon: Schema.optionalKey(ProjectIcon),
  commands: Schema.optionalKey(ProjectCommands),
  time: Schema.Struct({
    created: Schema.Number,
    updated: Schema.Number,
    initialized: Schema.optionalKey(Schema.Number),
  }),
  sandboxes: Schema.Array(Schema.String),
})

const ProjectUpdatePayload = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  icon: Schema.optionalKey(ProjectIcon),
  commands: Schema.optionalKey(ProjectCommands),
})

export const ProjectApi = HttpApi.make("project")
  .add(
    HttpApiGroup.make("project")
      .add(
        HttpApiEndpoint.get("list", "/project", {
          query: WorkspaceRoutingQuery,
          success: Schema.Array(ProjectInfo),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.list",
            summary: "List all projects",
            description: "Get a list of projects that have been opened with OpenCode.",
          }),
        ),
        HttpApiEndpoint.get("current", "/project/current", {
          query: WorkspaceRoutingQuery,
          success: ProjectInfo,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.current",
            summary: "Get current project",
            description: "Retrieve the currently active project that OpenCode is working with.",
          }),
        ),
        HttpApiEndpoint.post("initGit", "/project/git/init", {
          query: WorkspaceRoutingQuery,
          success: ProjectInfo,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.initGit",
            summary: "Initialize git repository",
            description: "Create a git repository for the current project and return the refreshed project info.",
          }),
        ),
        HttpApiEndpoint.patch("update", "/project/:projectID", {
          params: ProjectIDParam,
          query: WorkspaceRoutingQuery,
          payload: ProjectUpdatePayload,
          success: ProjectInfo,
          error: [BadRequestError, NotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "project.update",
            summary: "Update project",
            description: "Update project properties such as name, icon, and commands.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "project",
          description: "HttpApi project routes.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode project HttpApi",
      version: "0.0.1",
      description: "HttpApi surface for project routes.",
    }),
  )
