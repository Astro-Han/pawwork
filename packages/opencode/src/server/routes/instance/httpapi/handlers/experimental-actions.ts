import { Account, AccountID, OrgID } from "@/account"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { MCP } from "@/mcp"
import { ProviderID, ModelID } from "@/provider/schema"
import { Session } from "@/session"
import { SessionID } from "@/session/schema"
import { ToolRegistry } from "@/tool/registry"
import { Worktree } from "@/worktree"
import { Effect, Option } from "effect"
import z from "zod"
import { zodToJsonSchema } from "zod-to-json-schema"

type ConsoleSwitchBody = {
  accountID: string
  orgID: string
}

type ToolListQuery = {
  provider: string
  model: string
}

export const getConsoleState = Effect.fn("ExperimentalHttpApi.console.get")(function* () {
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

export const listConsoleOrgs = Effect.fn("ExperimentalHttpApi.console.listOrgs")(function* () {
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

export const switchConsoleOrg = Effect.fn("ExperimentalHttpApi.console.switchOrg")(function* (body: ConsoleSwitchBody) {
  const account = yield* Account.Service
  yield* account.use(AccountID.make(body.accountID), Option.some(OrgID.make(body.orgID)))
  return true
})

export const listToolIDs = Effect.fn("ExperimentalHttpApi.tool.ids")(function* () {
  const registry = yield* ToolRegistry.Service
  return yield* registry.ids()
})

export const listTools = Effect.fn("ExperimentalHttpApi.tool.list")(function* ({ provider, model }: ToolListQuery) {
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

export const createWorktree = Effect.fn("ExperimentalHttpApi.worktree.create")(function* (body?: Worktree.CreateInput) {
  const worktrees = yield* Worktree.Service
  return yield* worktrees.create(body)
})

export const listWorktrees = Effect.fn("ExperimentalHttpApi.worktree.list")(function* () {
  const worktrees = yield* Worktree.Service
  return yield* worktrees.list()
})

export const removeWorktree = Effect.fn("ExperimentalHttpApi.worktree.remove")(function* (body: Worktree.RemoveInput) {
  const worktrees = yield* Worktree.Service
  yield* worktrees.remove(body)
  return true
})

export const resetWorktree = Effect.fn("ExperimentalHttpApi.worktree.reset")(function* (body: Worktree.ResetInput) {
  const worktrees = yield* Worktree.Service
  yield* worktrees.reset(body)
  return true
})

export const listResources = Effect.fn("ExperimentalHttpApi.resource.list")(function* () {
  const mcp = yield* MCP.Service
  return yield* mcp.resources()
})

function encodeCreatedSessionCursor(session: Session.GlobalInfo) {
  return Buffer.from(JSON.stringify({ created: session.time.created, id: session.id }), "utf8").toString("base64url")
}

const CreatedSessionCursor = z.object({ created: z.number(), id: SessionID.zod })
const ActivitySessionCursor = z.object({ activityAt: z.number(), id: SessionID.zod })

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

export type ExperimentalSessionListQuery = {
  directory?: string
  roots?: boolean
  start?: number
  cursor?: string | number
  search?: string
  limit?: number
  archived?: boolean
  sort?: "updated" | "created" | "activity"
}

export async function listExperimentalSessions(query: ExperimentalSessionListQuery) {
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
  const last = list[list.length - 1]
  const nextCursor =
    hasMore && last
      ? query.sort === "created"
        ? encodeCreatedSessionCursor(last)
        : query.sort === "activity"
          ? encodeActivitySessionCursor(last)
          : String(last.time.updated)
      : undefined

  return { sessions: list, hasMore, nextCursor }
}
