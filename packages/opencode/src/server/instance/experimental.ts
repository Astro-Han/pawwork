import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { ProviderID, ModelID } from "../../provider/schema"
import { ToolRegistry } from "../../tool/registry"
import { Worktree } from "../../worktree"
import { Instance } from "../../project/instance"
import { Project } from "../../project/project"
import { MCP } from "../../mcp"
import { Session } from "../../session"
import { Config } from "../../config/config"
import { ConsoleState } from "../../config/console-state"
import { Account, AccountID, OrgID } from "../../account"
import { AppRuntime } from "../../effect/app-runtime"
import { zodToJsonSchema } from "zod-to-json-schema"
import { errors } from "../error"
import { lazy } from "../../util/lazy"
import { Effect, Option } from "effect"
import { WorkspaceRoutes } from "./workspace"
import { Agent } from "@/agent/agent"
import { SessionID } from "@/session/schema"

const ConsoleOrgOption = z.object({
  accountID: z.string(),
  accountEmail: z.string(),
  accountUrl: z.string(),
  orgID: z.string(),
  orgName: z.string(),
  active: z.boolean(),
})

const ConsoleOrgList = z.object({
  orgs: z.array(ConsoleOrgOption),
})

const ConsoleSwitchBody = z.object({
  accountID: z.string(),
  orgID: z.string(),
})
type ConsoleSwitchBody = z.infer<typeof ConsoleSwitchBody>

type ToolListQuery = {
  provider: string
  model: string
}

export const getConsoleState = Effect.fn("ExperimentalRoutes.console.get")(function* () {
  const config = yield* Config.Service
  const account = yield* Account.Service
  const [state, groups] = yield* Effect.all([config.getConsoleState(), account.orgsByAccount()], {
    concurrency: "unbounded",
  })
  return {
    ...state,
    switchableOrgCount: groups.reduce((count, group) => count + group.orgs.length, 0),
  }
})

export const listConsoleOrgs = Effect.fn("ExperimentalRoutes.console.listOrgs")(function* () {
  const account = yield* Account.Service
  const [groups, active] = yield* Effect.all([account.orgsByAccount(), account.active()], {
    concurrency: "unbounded",
  })
  const info = Option.getOrUndefined(active)
  return {
    orgs: groups.flatMap((group) =>
      group.orgs.map((org) => ({
        accountID: group.account.id,
        accountEmail: group.account.email,
        accountUrl: group.account.url,
        orgID: org.id,
        orgName: org.name,
        active: !!info && info.id === group.account.id && info.active_org_id === org.id,
      })),
    ),
  }
})

export const switchConsoleOrg = Effect.fn("ExperimentalRoutes.console.switchOrg")(function* (body: ConsoleSwitchBody) {
  const account = yield* Account.Service
  yield* account.use(AccountID.make(body.accountID), Option.some(OrgID.make(body.orgID)))
  return true
})

export const listToolIDs = Effect.fn("ExperimentalRoutes.tool.ids")(function* () {
  const registry = yield* ToolRegistry.Service
  return yield* registry.ids()
})

export const listTools = Effect.fn("ExperimentalRoutes.tool.list")(function* ({ provider, model }: ToolListQuery) {
  const registry = yield* ToolRegistry.Service
  const agents = yield* Agent.Service
  const agent = yield* agents.get(yield* agents.defaultAgent())
  const tools = yield* registry.tools({
    providerID: ProviderID.make(provider),
    modelID: ModelID.make(model),
    agent,
  })
  return tools.map((tool) => ({
    id: tool.id,
    description: tool.description,
    // Handle both Zod schemas and plain JSON schemas.
    parameters: (tool.parameters as any)?._def ? zodToJsonSchema(tool.parameters as any) : tool.parameters,
  }))
})

export const createWorktree = Effect.fn("ExperimentalRoutes.worktree.create")(function* (body?: Worktree.CreateInput) {
  const worktrees = yield* Worktree.Service
  return yield* worktrees.create(body)
})

export const listWorktrees = Effect.fn("ExperimentalRoutes.worktree.list")(function* () {
  const worktrees = yield* Worktree.Service
  return yield* worktrees.list()
})

export const removeWorktree = Effect.fn("ExperimentalRoutes.worktree.remove")(function* (body: Worktree.RemoveInput) {
  const worktrees = yield* Worktree.Service
  yield* worktrees.remove(body)
  return true
})

export const resetWorktree = Effect.fn("ExperimentalRoutes.worktree.reset")(function* (body: Worktree.ResetInput) {
  const worktrees = yield* Worktree.Service
  yield* worktrees.reset(body)
  return true
})

export const listResources = Effect.fn("ExperimentalRoutes.resource.list")(function* () {
  const mcp = yield* MCP.Service
  return yield* mcp.resources()
})

function encodeCreatedSessionCursor(session: Session.GlobalInfo) {
  return Buffer.from(JSON.stringify({ created: session.time.created, id: session.id }), "utf8").toString("base64url")
}

const CreatedSessionCursor = z.object({ created: z.number(), id: SessionID.zod })
const ActivitySessionCursor = z.object({ activityAt: z.number(), id: SessionID.zod })
// z.coerce.boolean() runs Boolean(value), so the string "false" coerces to true and clients
// can never disable a boolean query flag. Parse the literal strings instead.
const QueryBoolean = z.enum(["true", "false"]).transform((value) => value === "true")

function decodeCreatedSessionCursor(value: string | number | undefined) {
  if (value === undefined) return undefined
  if (typeof value === "number") return undefined
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
    const parsed = CreatedSessionCursor.safeParse(decoded)
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

function encodeActivitySessionCursor(session: Session.GlobalInfo) {
  if (session.activityAt === undefined) return undefined
  return Buffer.from(JSON.stringify({ activityAt: session.activityAt, id: session.id }), "utf8").toString("base64url")
}

function decodeActivitySessionCursor(value: string | number | undefined) {
  if (value === undefined) return undefined
  if (typeof value === "number") return undefined
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
    const parsed = ActivitySessionCursor.safeParse(decoded)
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

function decodeUpdatedSessionCursor(value: string | number | undefined) {
  if (value === undefined) return undefined
  const cursor = typeof value === "number" ? value : Number(value)
  return Number.isFinite(cursor) ? cursor : undefined
}

export const ExperimentalRoutes = lazy(() =>
  new Hono()
    .get(
      "/console",
      describeRoute({
        summary: "Get active Console provider metadata",
        description: "Get the active Console org name and the set of provider IDs managed by that Console org.",
        operationId: "experimental.console.get",
        responses: {
          200: {
            description: "Active Console provider metadata",
            content: {
              "application/json": {
                schema: resolver(ConsoleState.zod),
              },
            },
          },
        },
      }),
      async (c) => {
        const result = await AppRuntime.runPromise(getConsoleState())
        return c.json(result)
      },
    )
    .get(
      "/console/orgs",
      describeRoute({
        summary: "List switchable Console orgs",
        description: "Get the available Console orgs across logged-in accounts, including the current active org.",
        operationId: "experimental.console.listOrgs",
        responses: {
          200: {
            description: "Switchable Console orgs",
            content: {
              "application/json": {
                schema: resolver(ConsoleOrgList),
              },
            },
          },
        },
      }),
      async (c) => {
        const orgs = await AppRuntime.runPromise(listConsoleOrgs())
        return c.json(orgs)
      },
    )
    .post(
      "/console/switch",
      describeRoute({
        summary: "Switch active Console org",
        description: "Persist a new active Console account/org selection for the current local OpenCode state.",
        operationId: "experimental.console.switchOrg",
        responses: {
          200: {
            description: "Switch success",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      validator("json", ConsoleSwitchBody),
      async (c) => {
        const body = c.req.valid("json")
        const result = await AppRuntime.runPromise(switchConsoleOrg(body))
        return c.json(result)
      },
    )
    .get(
      "/tool/ids",
      describeRoute({
        summary: "List tool IDs",
        description:
          "Get a list of all available tool IDs, including both built-in tools and dynamically registered tools.",
        operationId: "tool.ids",
        responses: {
          200: {
            description: "Tool IDs",
            content: {
              "application/json": {
                schema: resolver(z.array(z.string()).meta({ ref: "ToolIDs" })),
              },
            },
          },
          ...errors(400),
        },
      }),
      async (c) => {
        const ids = await AppRuntime.runPromise(listToolIDs())
        return c.json(ids)
      },
    )
    .get(
      "/tool",
      describeRoute({
        summary: "List tools",
        description:
          "Get a list of available tools with their JSON schema parameters for a specific provider and model combination.",
        operationId: "tool.list",
        responses: {
          200: {
            description: "Tools",
            content: {
              "application/json": {
                schema: resolver(
                  z
                    .array(
                      z
                        .object({
                          id: z.string(),
                          description: z.string(),
                          parameters: z.any(),
                        })
                        .meta({ ref: "ToolListItem" }),
                    )
                    .meta({ ref: "ToolList" }),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "query",
        z.object({
          provider: z.string(),
          model: z.string(),
        }),
      ),
      async (c) => {
        const { provider, model } = c.req.valid("query")
        const tools = await AppRuntime.runPromise(listTools({ provider, model }))
        return c.json(tools)
      },
    )
    .route("/workspace", WorkspaceRoutes())
    .post(
      "/worktree",
      describeRoute({
        summary: "Create worktree",
        description: "Create a new git worktree for the current project and run any configured startup scripts.",
        operationId: "worktree.create",
        responses: {
          200: {
            description: "Worktree created",
            content: {
              "application/json": {
                schema: resolver(Worktree.Info),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Worktree.CreateInput.optional()),
      async (c) => {
        const body = c.req.valid("json")
        const worktree = await AppRuntime.runPromise(createWorktree(body))
        return c.json(worktree)
      },
    )
    .get(
      "/worktree",
      describeRoute({
        summary: "List worktrees",
        description: "List all sandbox worktrees for the current project.",
        operationId: "worktree.list",
        responses: {
          200: {
            description: "List of worktrees",
            content: {
              "application/json": {
                schema: resolver(z.array(Worktree.Info)),
              },
            },
          },
        },
      }),
      async (c) => {
        const worktrees = await AppRuntime.runPromise(listWorktrees())
        return c.json(worktrees)
      },
    )
    .delete(
      "/worktree",
      describeRoute({
        summary: "Remove worktree",
        description: "Remove a git worktree and delete its branch.",
        operationId: "worktree.remove",
        responses: {
          200: {
            description: "Worktree removed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Worktree.RemoveInput),
      async (c) => {
        const body = c.req.valid("json")
        const result = await AppRuntime.runPromise(removeWorktree(body))
        return c.json(result)
      },
    )
    .post(
      "/worktree/reset",
      describeRoute({
        summary: "Reset worktree",
        description: "Reset a worktree branch to the primary default branch.",
        operationId: "worktree.reset",
        responses: {
          200: {
            description: "Worktree reset",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Worktree.ResetInput),
      async (c) => {
        const body = c.req.valid("json")
        const result = await AppRuntime.runPromise(resetWorktree(body))
        return c.json(result)
      },
    )
    .get(
      "/session",
      describeRoute({
        summary: "List sessions",
        description:
          "Get a list of all OpenCode sessions across projects. Defaults to most recently updated; use sort=created for creation-time order or sort=activity for latest user-message activity order. Archived sessions are excluded by default.",
        operationId: "experimental.session.list",
        responses: {
          200: {
            description: "List of sessions",
            content: {
              "application/json": {
                schema: resolver(Session.GlobalInfo.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          directory: z.string().optional().meta({ description: "Filter sessions by project directory" }),
          roots: QueryBoolean.optional().meta({ description: "Only return root sessions (no parentID)" }),
          start: z.coerce
            .number()
            .optional()
            .meta({ description: "Filter sessions updated on or after this timestamp (milliseconds since epoch)" }),
          cursor: z
            .preprocess(
              (value) => (value === "" ? undefined : value),
              z.union([z.coerce.number(), z.string()]).optional(),
            )
            .optional()
            .meta({ description: "Cursor for loading the next page" }),
          search: z.string().optional().meta({ description: "Filter sessions by title (case-insensitive)" }),
          limit: z.coerce.number().optional().meta({ description: "Maximum number of sessions to return" }),
          archived: QueryBoolean.optional().meta({ description: "Include archived sessions (default false)" }),
          sort: z
            .enum(["updated", "created", "activity"])
            .optional()
            .meta({ description: "Sort sessions by last update, creation time, or latest user-message activity" }),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        const limit = query.limit ?? 100
        const sessions: Session.GlobalInfo[] = []
        for await (const session of Session.listGlobal({
          directory: query.directory,
          roots: query.roots,
          start: query.start,
          cursor:
            query.sort === "created"
              ? decodeCreatedSessionCursor(query.cursor)
              : query.sort === "activity"
                ? decodeActivitySessionCursor(query.cursor)
              : decodeUpdatedSessionCursor(query.cursor),
          search: query.search,
          limit: limit + 1,
          archived: query.archived,
          sort: query.sort,
        })) {
          sessions.push(session)
        }
        const hasMore = sessions.length > limit
        const list = hasMore ? sessions.slice(0, limit) : sessions
        if (hasMore && list.length > 0) {
          c.header("Access-Control-Expose-Headers", "X-Next-Cursor")
          c.header(
            "x-next-cursor",
            query.sort === "created"
              ? encodeCreatedSessionCursor(list[list.length - 1])
              : query.sort === "activity"
                ? encodeActivitySessionCursor(list[list.length - 1])
              : String(list[list.length - 1].time.updated),
          )
        }
        return c.json(list)
      },
    )
    .get(
      "/resource",
      describeRoute({
        summary: "Get MCP resources",
        description: "Get all available MCP resources from connected servers. Optionally filter by name.",
        operationId: "experimental.resource.list",
        responses: {
          200: {
            description: "MCP resources",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), MCP.Resource)),
              },
            },
          },
        },
      }),
      async (c) => {
        const resources = await AppRuntime.runPromise(listResources())
        return c.json(resources)
      },
    ),
)
