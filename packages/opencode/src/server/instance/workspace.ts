import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { Effect } from "effect"
import z from "zod"
import { Workspace } from "../../control-plane/workspace"
import { Instance } from "../../project/instance"
import { errors } from "../error"
import { lazy } from "../../util/lazy"
import { AppRuntime } from "../../effect/app-runtime"

function preserveWorkspaceRouteError<A>(effect: Effect.Effect<A, Workspace.WorkspaceError>) {
  return effect.pipe(
    Effect.catch((error) => {
      // Preserve facade-era errors so ErrorMiddleware keeps existing NamedError status mapping.
      if (error.cause instanceof Error) return Effect.fail(error.cause)
      return Effect.fail(error)
    }),
  )
}

const runWorkspaceRoute: typeof AppRuntime.runPromise = (effect, options) => AppRuntime.runPromise(effect, options)
type WorkspaceCreateBody = Omit<Workspace.CreateInput, "projectID">

const createWorkspace = Effect.fn("WorkspaceRoutes.create")(function* (body: WorkspaceCreateBody) {
  const workspace = yield* Workspace.Service
  return yield* preserveWorkspaceRouteError(
    workspace.create({
      projectID: Instance.project.id,
      ...body,
    }),
  )
})

const listWorkspaces = Effect.fn("WorkspaceRoutes.list")(function* () {
  const workspace = yield* Workspace.Service
  return yield* preserveWorkspaceRouteError(workspace.list(Instance.project))
})

const getWorkspaceStatus = Effect.fn("WorkspaceRoutes.status")(function* () {
  const workspace = yield* Workspace.Service
  const workspaces = yield* preserveWorkspaceRouteError(workspace.list(Instance.project))
  const ids = new Set(workspaces.map((item) => item.id))
  const statuses = yield* preserveWorkspaceRouteError(workspace.status())
  return statuses.filter((item) => ids.has(item.workspaceID))
})

const removeWorkspace = Effect.fn("WorkspaceRoutes.remove")(function* (id: Workspace.Info["id"]) {
  const workspace = yield* Workspace.Service
  return yield* preserveWorkspaceRouteError(workspace.remove(id))
})

export const WorkspaceRoutes = lazy(() =>
  new Hono()
    .post(
      "/",
      describeRoute({
        summary: "Create workspace",
        description: "Create a workspace for the current project.",
        operationId: "experimental.workspace.create",
        responses: {
          200: {
            description: "Workspace created",
            content: {
              "application/json": {
                schema: resolver(Workspace.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        Workspace.create.schema.omit({
          projectID: true,
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const workspace = await runWorkspaceRoute(createWorkspace(body))
        return c.json(workspace)
      },
    )
    .get(
      "/",
      describeRoute({
        summary: "List workspaces",
        description: "List all workspaces.",
        operationId: "experimental.workspace.list",
        responses: {
          200: {
            description: "Workspaces",
            content: {
              "application/json": {
                schema: resolver(z.array(Workspace.Info)),
              },
            },
          },
        },
      }),
      async (c) => {
        const workspaces = await runWorkspaceRoute(listWorkspaces())
        return c.json(workspaces)
      },
    )
    .get(
      "/status",
      describeRoute({
        summary: "Workspace status",
        description: "Get connection status for workspaces in the current project.",
        operationId: "experimental.workspace.status",
        responses: {
          200: {
            description: "Workspace status",
            content: {
              "application/json": {
                schema: resolver(z.array(Workspace.ConnectionStatus)),
              },
            },
          },
        },
      }),
      async (c) => {
        const status = await runWorkspaceRoute(getWorkspaceStatus())
        return c.json(status)
      },
    )
    .delete(
      "/:id",
      describeRoute({
        summary: "Remove workspace",
        description: "Remove an existing workspace.",
        operationId: "experimental.workspace.remove",
        responses: {
          200: {
            description: "Workspace removed",
            content: {
              "application/json": {
                schema: resolver(Workspace.Info.optional()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          id: Workspace.Info.shape.id,
        }),
      ),
      async (c) => {
        const { id } = c.req.valid("param")
        const workspace = await runWorkspaceRoute(removeWorkspace(id))
        return c.json(workspace)
      },
    ),
)
