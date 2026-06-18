import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import { Effect } from "effect"
import { Instance } from "../../project/instance"
import { Project } from "../../project/project"
import z from "zod"
import { ProjectID } from "../../project/schema"
import { errors } from "../error"
import { lazy } from "../../util/lazy"
import { AppRuntime } from "../../effect/app-runtime"

const runProjectRoute: typeof AppRuntime.runPromise = (effect, options) => AppRuntime.runPromise(effect, options)

const listProjects = Effect.fn("ProjectRoutes.list")(function* () {
  const project = yield* Project.Service
  return yield* project.list()
})

const initGit = Effect.fn("ProjectRoutes.git.init")(function* (input: { directory: string; project: Project.Info }) {
  const project = yield* Project.Service
  const next = yield* project.initGit(input)
  if (next.id === input.project.id && next.vcs === input.project.vcs && next.worktree === input.project.worktree)
    return next
  yield* Effect.promise(() =>
    Instance.reload({
      directory: input.directory,
      worktree: input.directory,
      project: next,
    }),
  )
  return next
})

const updateProject = Effect.fn("ProjectRoutes.update")(function* (input: Project.UpdateInput) {
  const project = yield* Project.Service
  return yield* project.update(input)
})

export const ProjectRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List all projects",
        description: "Get a list of projects that have been opened with OpenCode.",
        operationId: "project.list",
        responses: {
          200: {
            description: "List of projects",
            content: {
              "application/json": {
                schema: resolver(Project.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const projects = await runProjectRoute(listProjects())
        return c.json(projects)
      },
    )
    .get(
      "/current",
      describeRoute({
        summary: "Get current project",
        description: "Retrieve the currently active project that OpenCode is working with.",
        operationId: "project.current",
        responses: {
          200: {
            description: "Current project information",
            content: {
              "application/json": {
                schema: resolver(Project.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(Instance.project)
      },
    )
    .post(
      "/git/init",
      describeRoute({
        summary: "Initialize git repository",
        description: "Create a git repository for the current project and return the refreshed project info.",
        operationId: "project.initGit",
        responses: {
          200: {
            description: "Project information after git initialization",
            content: {
              "application/json": {
                schema: resolver(Project.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        const dir = Instance.directory
        const prev = Instance.project
        const next = await runProjectRoute(initGit({ directory: dir, project: prev }))
        return c.json(next)
      },
    )
    .patch(
      "/:projectID",
      describeRoute({
        summary: "Update project",
        description: "Update project properties such as name, icon, and commands.",
        operationId: "project.update",
        responses: {
          200: {
            description: "Updated project information",
            content: {
              "application/json": {
                schema: resolver(Project.Info),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ projectID: ProjectID.zod })),
      validator("json", Project.UpdateInput.omit({ projectID: true })),
      async (c) => {
        const projectID = c.req.valid("param").projectID
        const body = c.req.valid("json")
        const project = await runProjectRoute(updateProject({ ...body, projectID }))
        return c.json(project)
      },
    ),
)
