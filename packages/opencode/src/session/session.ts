import { Slug } from "@opencode-ai/util/slug"
import path from "path"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Decimal } from "decimal.js"
import z from "zod"
import { type ProviderMetadata, type LanguageModelUsage } from "ai"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Installation } from "../installation"

import { Database, NotFoundError, eq, and, or, gte, isNull, desc, asc, like, inArray, lt, gt, sql } from "../storage/db"
import { SyncEvent } from "../sync"
import type { SQL } from "../storage/db"
import { PartTable, SessionTable } from "./session.sql"
import { ProjectTable } from "../project/project.sql"
import { Storage } from "@/storage/storage"
import { Log } from "@opencode-ai/core/util/log"
import { updateSchema } from "../util/update-schema"
import { MessageV2 } from "./message-v2"
import { Instance } from "../project/instance"
import { InstanceState } from "@/effect"
import { Snapshot } from "@/snapshot"
import { ProjectID } from "../project/schema"
import { WorkspaceID } from "../control-plane/schema"
import { SessionID, MessageID, PartID } from "./schema"
import { fn } from "../util/fn"
import { makeRuntime } from "../effect/run-service"
import { Runtime } from "@opencode-ai/core/runtime"

import type { Provider } from "@/provider"
import { Permission } from "@/permission"
import { Global } from "@/global"
import { Effect, Layer, Option, Context } from "effect"
import { SubagentRunWriterContext, SubagentRunGuardViolation, lifecycleFieldsChanged } from "./subagent-run-context"
import { ActiveWorktree, SessionExecutionContext, canonicalDirectory, rootContext, sameDirectory } from "./execution-context"
import { backfillExecutionContextRows } from "./execution-context-store"

const log = Log.create({ service: "session" })

const parentTitlePrefix = "New session - "
const childTitlePrefix = "Child session - "

function createDefaultTitle(isChild = false) {
  return (isChild ? childTitlePrefix : parentTitlePrefix) + new Date().toISOString()
}

export function isDefaultTitle(title: string) {
  return new RegExp(
    `^(${parentTitlePrefix}|${childTitlePrefix})\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$`,
  ).test(title)
}

type SessionRow = typeof SessionTable.$inferSelect
type ProjectFallback = { worktree?: string | null; vcs?: string | null }

function legacyExecutionContext(row: SessionRow, project: ProjectFallback | undefined) {
  const ownerDirectoryRaw = project?.vcs === "git" ? (project.worktree ?? row.directory) : row.directory
  return rootContext(canonicalDirectory(ownerDirectoryRaw))
}

function recoverExecutionContext(row: SessionRow) {
  const raw = row.execution_context
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const ownerDirectory = record.ownerDirectory
  const activeDirectory = record.activeDirectory
  if (
    typeof ownerDirectory !== "string" ||
    typeof activeDirectory !== "string" ||
    !path.isAbsolute(ownerDirectory) ||
    !path.isAbsolute(activeDirectory)
  ) {
    return undefined
  }

  const activeWorktreeRaw = record.activeWorktree
  let activeWorktree: ActiveWorktree | undefined
  if (activeWorktreeRaw && typeof activeWorktreeRaw === "object" && !Array.isArray(activeWorktreeRaw)) {
    const worktree = activeWorktreeRaw as Record<string, unknown>
    const directory = worktree.directory
    if (typeof directory === "string" && path.isAbsolute(directory)) {
      const parsed = ActiveWorktree.safeParse({
        directory: canonicalDirectory(directory),
        name: worktree.name,
        branch: worktree.branch,
        source: worktree.source,
      })
      if (parsed.success) activeWorktree = parsed.data
    }
  }

  const recovered = SessionExecutionContext.safeParse({
    ownerDirectory: canonicalDirectory(ownerDirectory),
    activeDirectory: canonicalDirectory(activeDirectory),
    activeWorktree,
    lastChangedAt:
      typeof record.lastChangedAt === "number" && Number.isFinite(record.lastChangedAt)
        ? record.lastChangedAt
        : row.time_updated,
  })
  return recovered.success ? normalizeExecutionContext(recovered.data) : undefined
}

function isPersistedExecutionContextUsable(ctx: SessionExecutionContext) {
  return (
    path.isAbsolute(ctx.ownerDirectory) &&
    path.isAbsolute(ctx.activeDirectory) &&
    (!ctx.activeWorktree || path.isAbsolute(ctx.activeWorktree.directory))
  )
}

function normalizeExecutionContext(ctx: SessionExecutionContext): SessionExecutionContext {
  const ownerDirectory = canonicalDirectory(ctx.ownerDirectory)
  const activeDirectory = canonicalDirectory(ctx.activeDirectory)
  return {
    ...ctx,
    ownerDirectory,
    activeDirectory,
    activeWorktree:
      ctx.activeWorktree && !sameDirectory(activeDirectory, ownerDirectory)
        ? {
            ...ctx.activeWorktree,
            directory: canonicalDirectory(ctx.activeWorktree.directory),
          }
        : undefined,
  }
}

function parseExecutionContext(row: SessionRow, project: ProjectFallback | undefined) {
  if (row.execution_context !== null) {
    const parsed = SessionExecutionContext.safeParse(row.execution_context)
    if (parsed.success && isPersistedExecutionContextUsable(parsed.data)) return normalizeExecutionContext(parsed.data)
    const recovered = recoverExecutionContext(row)
    if (recovered) return recovered
  }
  return legacyExecutionContext(row, project)
}

function needsProjectFallback(row: SessionRow) {
  const parsed = SessionExecutionContext.safeParse(row.execution_context)
  return !parsed.success || !isPersistedExecutionContextUsable(parsed.data)
}

export function fromRow(row: SessionRow, project: ProjectFallback | undefined): Info {
  const summary =
    row.summary_additions !== null || row.summary_deletions !== null || row.summary_files !== null
      ? {
          additions: row.summary_additions ?? 0,
          deletions: row.summary_deletions ?? 0,
          files: row.summary_files ?? 0,
          diffs: row.summary_diffs ?? undefined,
        }
      : undefined
  const share = row.share_url ? { url: row.share_url } : undefined
  const revert = row.revert ?? undefined
  return {
    id: row.id,
    slug: row.slug,
    projectID: row.project_id,
    workspaceID: row.workspace_id ?? undefined,
    directory: row.directory,
    parentID: row.parent_id ?? undefined,
    createdByAgentTool: row.created_by_agent_tool ?? false,
    subagentType: row.subagent_type ?? null,
    title: row.title,
    skill: row.skill ?? undefined,
    version: row.version,
    summary,
    share,
    revert,
    permission: row.permission ?? undefined,
    executionContext: parseExecutionContext(row, project),
    time: {
      created: row.time_created,
      updated: row.time_updated,
      compacting: row.time_compacting ?? undefined,
      archived: row.time_archived ?? undefined,
    },
  }
}

export function toRow(info: Info) {
  return {
    id: info.id,
    project_id: info.projectID,
    workspace_id: info.workspaceID,
    parent_id: info.parentID,
    created_by_agent_tool: info.createdByAgentTool,
    subagent_type: info.subagentType,
    slug: info.slug,
    directory: info.directory,
    execution_context: info.executionContext,
    title: info.title,
    skill: info.skill,
    version: info.version,
    share_url: info.share?.url,
    summary_additions: info.summary?.additions,
    summary_deletions: info.summary?.deletions,
    summary_files: info.summary?.files,
    summary_diffs: info.summary?.diffs,
    revert: info.revert ?? null,
    permission: info.permission,
    time_created: info.time.created,
    time_updated: info.time.updated,
    time_compacting: info.time.compacting,
    time_archived: info.time.archived,
  }
}

function getForkedTitle(title: string): string {
  const match = title.match(/^(.+) \(fork #(\d+)\)$/)
  if (match) {
    const base = match[1]
    const num = parseInt(match[2], 10)
    return `${base} (fork #${num + 1})`
  }
  return `${title} (fork #1)`
}

export const Info = z
  .object({
    id: SessionID.zod,
    slug: z.string(),
    projectID: ProjectID.zod,
    workspaceID: WorkspaceID.zod.optional(),
    directory: z.string(),
    parentID: SessionID.zod.optional(),
    createdByAgentTool: z.boolean().default(false),
    subagentType: z.string().nullable().default(null),
    skill: z.string().optional(),
    summary: z
      .object({
        additions: z.number(),
        deletions: z.number(),
        files: z.number(),
        diffs: Snapshot.FileDiff.array().optional(),
      })
      .optional(),
    share: z
      .object({
        url: z.string(),
      })
      .optional(),
    title: z.string(),
    version: z.string(),
    time: z.object({
      created: z.number(),
      updated: z.number(),
      compacting: z.number().optional(),
      archived: z.number().optional(),
    }),
    permission: Permission.Ruleset.optional(),
    revert: z
      .object({
        messageID: MessageID.zod,
        partID: PartID.zod.optional(),
        snapshot: z.string().optional(),
        diff: z.string().optional(),
      })
      .optional(),
    executionContext: SessionExecutionContext,
  })
  .meta({
    ref: "Session",
  })
export type Info = z.output<typeof Info>

export const ProjectInfo = z
  .object({
    id: ProjectID.zod,
    name: z.string().optional(),
    worktree: z.string(),
  })
  .meta({
    ref: "ProjectSummary",
  })
export type ProjectInfo = z.output<typeof ProjectInfo>

export const GlobalInfo = Info.extend({
  project: ProjectInfo.nullable(),
}).meta({
  ref: "GlobalSession",
})
export type GlobalInfo = z.output<typeof GlobalInfo>

export const CreateInput = z
  .object({
    parentID: SessionID.zod.optional(),
    title: z.string().optional(),
    skill: z.string().optional(),
    permission: Info.shape.permission,
    workspaceID: WorkspaceID.zod.optional(),
    createdByAgentTool: z.boolean().optional(),
    subagentType: z.string().nullable().optional(),
  })
  .optional()
export type CreateInput = z.output<typeof CreateInput>

export const ForkInput = z.object({ sessionID: SessionID.zod, messageID: MessageID.zod.optional() })
export const GetInput = SessionID.zod
export const ChildrenInput = SessionID.zod
export const RemoveInput = SessionID.zod
export const SetTitleInput = z.object({ sessionID: SessionID.zod, title: z.string() })
export const SetArchivedInput = z.object({ sessionID: SessionID.zod, time: z.number().optional() })
export const SetPermissionInput = z.object({ sessionID: SessionID.zod, permission: Permission.Ruleset })
export const SetRevertInput = z.object({
  sessionID: SessionID.zod,
  revert: Info.shape.revert,
  summary: Info.shape.summary,
})
export const MessagesInput = z.object({ sessionID: SessionID.zod, limit: z.number().optional() })
const AbsoluteDirectory = z
  .string()
  .min(1, "Expected an absolute directory path")
  .refine((value) => path.isAbsolute(value), "Expected an absolute directory path")
const ActiveWorktreeInput = ActiveWorktree.extend({
  directory: AbsoluteDirectory,
})
export const UpdateExecutionContextInput = z.object({
  sessionID: SessionID.zod,
  activeDirectory: AbsoluteDirectory.optional(),
  activeWorktree: ActiveWorktreeInput.nullable().optional(),
})
export const FindActiveWorktreeBindingInput = AbsoluteDirectory
export const RemovePartInput = z.object({
  sessionID: SessionID.zod,
  messageID: MessageID.zod,
  partID: PartID.zod,
})

export const Event = {
  Created: SyncEvent.define({
    type: "session.created",
    version: 1,
    aggregate: "sessionID",
    schema: z.object({
      sessionID: SessionID.zod,
      info: Info,
    }),
  }),
  Updated: SyncEvent.define({
    type: "session.updated",
    version: 1,
    aggregate: "sessionID",
    schema: z.object({
      sessionID: SessionID.zod,
      info: updateSchema(Info).extend({
        share: updateSchema(Info.shape.share.unwrap()).optional(),
        time: updateSchema(Info.shape.time).optional(),
      }),
    }),
    busSchema: z.object({
      sessionID: SessionID.zod,
      info: Info,
    }),
  }),
  Deleted: SyncEvent.define({
    type: "session.deleted",
    version: 1,
    aggregate: "sessionID",
    schema: z.object({
      sessionID: SessionID.zod,
      info: Info,
    }),
  }),
  Diff: BusEvent.define(
    "session.diff",
    z.object({
      sessionID: SessionID.zod,
      diff: Snapshot.FileDiff.array(),
    }),
  ),
  Error: BusEvent.define(
    "session.error",
    z.object({
      sessionID: SessionID.zod.optional(),
      // z.lazy avoids eager access to MessageV2.Assistant while session.ts is still initializing.
      error: z.lazy(() => MessageV2.Assistant.shape.error),
    }),
  ),
}

export function plan(input: { slug: string; time: { created: number } }) {
  const base = Instance.project.vcs
    ? path.join(Instance.worktree, Runtime.isPawWork() ? ".pawwork" : ".opencode", "plans")
    : path.join(Global.Path.data, "plans")
  return path.join(base, [input.time.created, input.slug].join("-") + ".md")
}

export const getUsage = (input: { model: Provider.Model; usage: LanguageModelUsage; metadata?: ProviderMetadata }) => {
  const safe = (value: number) => {
    if (!Number.isFinite(value)) return 0
    return value
  }
  const inputTokens = safe(input.usage.inputTokens ?? 0)
  const outputTokens = safe(input.usage.outputTokens ?? 0)
  const reasoningTokens = safe(input.usage.outputTokenDetails?.reasoningTokens ?? input.usage.reasoningTokens ?? 0)

  const cacheReadInputTokens = safe(
    input.usage.inputTokenDetails?.cacheReadTokens ?? input.usage.cachedInputTokens ?? 0,
  )
  const cacheWriteInputTokens = safe(
    Number(
      input.usage.inputTokenDetails?.cacheWriteTokens ??
        input.metadata?.["anthropic"]?.["cacheCreationInputTokens"] ??
        // google-vertex-anthropic returns metadata under "vertex" key
        // (AnthropicMessagesLanguageModel custom provider key from 'vertex.anthropic.messages')
        input.metadata?.["vertex"]?.["cacheCreationInputTokens"] ??
        // @ts-expect-error
        input.metadata?.["bedrock"]?.["usage"]?.["cacheWriteInputTokens"] ??
        // @ts-expect-error
        input.metadata?.["venice"]?.["usage"]?.["cacheCreationInputTokens"] ??
        0,
    ),
  )

  // AI SDK v6 normalized inputTokens to include cached tokens across all providers
  // (including Anthropic/Bedrock which previously excluded them). Always subtract cache
  // tokens to get the non-cached input count for separate cost calculation.
  const adjustedInputTokens = safe(inputTokens - cacheReadInputTokens - cacheWriteInputTokens)

  const total = input.usage.totalTokens

  const tokens = {
    total,
    input: adjustedInputTokens,
    output: safe(outputTokens - reasoningTokens),
    reasoning: reasoningTokens,
    cache: {
      write: cacheWriteInputTokens,
      read: cacheReadInputTokens,
    },
  }

  const costInfo =
    input.model.cost?.experimentalOver200K && tokens.input + tokens.cache.read > 200_000
      ? input.model.cost.experimentalOver200K
      : input.model.cost
  return {
    cost: safe(
      new Decimal(0)
        .add(new Decimal(tokens.input).mul(costInfo?.input ?? 0).div(1_000_000))
        .add(new Decimal(tokens.output).mul(costInfo?.output ?? 0).div(1_000_000))
        .add(new Decimal(tokens.cache.read).mul(costInfo?.cache?.read ?? 0).div(1_000_000))
        .add(new Decimal(tokens.cache.write).mul(costInfo?.cache?.write ?? 0).div(1_000_000))
        // TODO: update models.dev to have better pricing model, for now:
        // charge reasoning tokens at the same rate as output tokens
        .add(new Decimal(tokens.reasoning).mul(costInfo?.output ?? 0).div(1_000_000))
        .toNumber(),
    ),
    tokens,
  }
}

export class BusyError extends Error {
  constructor(public readonly sessionID: string) {
    super(`Session ${sessionID} is busy`)
  }
}

export interface Interface {
  readonly create: (input?: {
    parentID?: SessionID
    title?: string
    skill?: string
    permission?: Permission.Ruleset
    workspaceID?: WorkspaceID
    createdByAgentTool?: boolean
    subagentType?: string | null
  }) => Effect.Effect<Info>
  readonly fork: (input: { sessionID: SessionID; messageID?: MessageID }) => Effect.Effect<Info>
  readonly touch: (sessionID: SessionID) => Effect.Effect<void>
  readonly get: (id: SessionID) => Effect.Effect<Info>
  readonly setTitle: (input: { sessionID: SessionID; title: string }) => Effect.Effect<void>
  readonly setArchived: (input: { sessionID: SessionID; time?: number }) => Effect.Effect<void>
  readonly setPermission: (input: { sessionID: SessionID; permission: Permission.Ruleset }) => Effect.Effect<void>
  readonly setRevert: (input: {
    sessionID: SessionID
    revert: Info["revert"]
    summary: Info["summary"]
  }) => Effect.Effect<void>
  readonly clearRevert: (sessionID: SessionID) => Effect.Effect<void>
  readonly setSummary: (input: { sessionID: SessionID; summary: Info["summary"] }) => Effect.Effect<void>
  readonly updateExecutionContext: (input: {
    sessionID: SessionID
    activeDirectory?: string
    activeWorktree?: SessionExecutionContext["activeWorktree"] | null
  }) => Effect.Effect<Info>
  readonly findActiveWorktreeBinding: (directory: string) => Effect.Effect<Info | undefined>
  readonly diff: (sessionID: SessionID) => Effect.Effect<Snapshot.FileDiff[]>
  readonly messages: (input: { sessionID: SessionID; limit?: number }) => Effect.Effect<MessageV2.WithParts[]>
  readonly children: (parentID: SessionID) => Effect.Effect<Info[]>
  readonly remove: (sessionID: SessionID) => Effect.Effect<void>
  readonly updateMessage: <T extends MessageV2.Info>(msg: T) => Effect.Effect<T>
  readonly removeMessage: (input: { sessionID: SessionID; messageID: MessageID }) => Effect.Effect<MessageID>
  readonly removePart: (input: { sessionID: SessionID; messageID: MessageID; partID: PartID }) => Effect.Effect<PartID>
  readonly getPart: (input: {
    sessionID: SessionID
    messageID: MessageID
    partID: PartID
  }) => Effect.Effect<MessageV2.Part | undefined>
  readonly updatePart: <T extends MessageV2.Part>(part: T) => Effect.Effect<T>
  readonly updatePartDelta: (input: {
    sessionID: SessionID
    messageID: MessageID
    partID: PartID
    field: string
    delta: string
  }) => Effect.Effect<void>
  /** Finds the first message matching the predicate, searching newest-first. */
  readonly findMessage: (
    sessionID: SessionID,
    predicate: (msg: MessageV2.WithParts) => boolean,
  ) => Effect.Effect<Option.Option<MessageV2.WithParts>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Session") {}

type Patch = z.infer<typeof Event.Updated.schema>["info"]

const db = <T>(fn: (d: Parameters<typeof Database.use>[0] extends (trx: infer D) => any ? D : never) => T) =>
  Effect.sync(() => Database.use(fn))

const backfillExecutionContextEffect = Effect.fn("Session.backfillExecutionContext")(function* () {
  return yield* db(backfillExecutionContextRows)
})

export const backfillExecutionContext = backfillExecutionContextEffect()

export const layer: Layer.Layer<Service, never, Bus.Service | Storage.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const storage = yield* Storage.Service
    yield* backfillExecutionContextEffect()

    const createNext = Effect.fn("Session.createNext")(function* (input: {
      id?: SessionID
      title?: string
      skill?: string
      parentID?: SessionID
      workspaceID?: WorkspaceID
      directory: string
      executionContext?: SessionExecutionContext
      permission?: Permission.Ruleset
      createdByAgentTool?: boolean
      subagentType?: string | null
    }) {
      const ctx = yield* InstanceState.context
      const result: Info = {
        id: SessionID.descending(input.id),
        slug: Slug.create(),
        version: Installation.VERSION,
        projectID: ctx.project.id,
        directory: input.directory,
        workspaceID: input.workspaceID,
        parentID: input.parentID,
        createdByAgentTool: input.createdByAgentTool ?? false,
        subagentType: input.subagentType ?? null,
        title: input.title ?? createDefaultTitle(!!input.parentID),
        skill: input.skill,
        permission: input.permission,
        // ownerDirectory is the project root for git projects and never moves. For non-git
        // projects Instance.worktree is "/" today, so keep the opened directory as the owner.
        executionContext: input.executionContext
          ? normalizeExecutionContext(input.executionContext)
          : rootContext(ctx.project.vcs === "git" ? ctx.worktree : input.directory),
        time: {
          created: Date.now(),
          updated: Date.now(),
        },
      }
      log.info("created", result)

      yield* Effect.sync(() => SyncEvent.run(Event.Created, { sessionID: result.id, info: result }))

      if (!Flag.OPENCODE_EXPERIMENTAL_WORKSPACES) {
        // This only exist for backwards compatibility. We should not be
        // manually publishing this event; it is a sync event now
        yield* bus.publish(Event.Updated, {
          sessionID: result.id,
          info: result,
        })
      }

      return result
    })

    const get = Effect.fn("Session.get")(function* (id: SessionID) {
      const row = yield* db((d) => d.select().from(SessionTable).where(eq(SessionTable.id, id)).get())
      if (!row) throw new NotFoundError({ message: `Session not found: ${id}` })
      const project = needsProjectFallback(row)
        ? yield* db((d) =>
            d
              .select({ worktree: ProjectTable.worktree, vcs: ProjectTable.vcs })
              .from(ProjectTable)
              .where(eq(ProjectTable.id, row.project_id))
              .get(),
          )
        : undefined
      return fromRow(row, project)
    })

    const children = Effect.fn("Session.children")(function* (parentID: SessionID) {
      const rows = yield* db((d) =>
        d
          .select()
          .from(SessionTable)
          .where(and(eq(SessionTable.parent_id, parentID)))
          .all(),
      )
      const ids = [...new Set(rows.filter(needsProjectFallback).map((row) => row.project_id))]
      const projects = new Map<string, ProjectFallback>()
      if (ids.length > 0) {
        const items = yield* db((d) =>
          d
            .select({ id: ProjectTable.id, worktree: ProjectTable.worktree, vcs: ProjectTable.vcs })
            .from(ProjectTable)
            .where(inArray(ProjectTable.id, ids))
            .all(),
        )
        for (const item of items) projects.set(item.id, item)
      }
      return rows.map((row) => fromRow(row, projects.get(row.project_id)))
    })

    const remove: Interface["remove"] = Effect.fnUntraced(function* (sessionID: SessionID) {
      try {
        const session = yield* get(sessionID)
        const kids = yield* children(sessionID)
        for (const child of kids) {
          yield* remove(child.id)
        }

        // `remove` needs to work in all cases, such as a broken
        // sessions that run cleanup. In certain cases these will
        // run without any instance state, so we need to turn off
        // publishing of events in that case
        const hasInstance = yield* InstanceState.directory.pipe(
          Effect.as(true),
          Effect.catchCause(() => Effect.succeed(false)),
        )

        yield* Effect.sync(() => {
          SyncEvent.run(Event.Deleted, { sessionID, info: session }, { publish: hasInstance })
          SyncEvent.remove(sessionID)
        })
      } catch (e) {
        log.error(e)
      }
    })

    const updateMessage = <T extends MessageV2.Info>(msg: T): Effect.Effect<T> =>
      Effect.gen(function* () {
        yield* Effect.sync(() => SyncEvent.run(MessageV2.Event.Updated, { sessionID: msg.sessionID, info: msg }))
        return msg
      }).pipe(Effect.withSpan("Session.updateMessage"))

    const updatePart = <T extends MessageV2.Part>(part: T): Effect.Effect<T> =>
      Effect.gen(function* () {
        if (part.type === "subtask") {
          const isWriter = yield* SubagentRunWriterContext
          if (!isWriter) {
            // No catch: getPart's typed error channel is never; defects (e.g. database failure)
            // should propagate so the guard can't be silently bypassed by a missing read.
            const existing = yield* getPart({
              sessionID: part.sessionID,
              messageID: part.messageID,
              partID: part.id,
            })
            // Only police mutations: first writes (existing === undefined) are allowed so
            // Session.fork() / migration / import paths can clone historical SubtaskParts with
            // their persisted lifecycle values. Once a part exists, lifecycle fields are frozen
            // for non-writers.
            if (
              existing &&
              lifecycleFieldsChanged(
                existing as unknown as Record<string, unknown>,
                part as unknown as Record<string, unknown>,
              )
            ) {
              return yield* Effect.die(new SubagentRunGuardViolation((part as { tool_call_id?: string }).tool_call_id))
            }
          }
        }
        yield* Effect.sync(() =>
          SyncEvent.run(MessageV2.Event.PartUpdated, {
            sessionID: part.sessionID,
            part: structuredClone(part),
            time: Date.now(),
          }),
        )
        return part
      }).pipe(Effect.withSpan("Session.updatePart"))

    const getPart: Interface["getPart"] = Effect.fn("Session.getPart")(function* (input) {
      const row = Database.use((db) =>
        db
          .select()
          .from(PartTable)
          .where(
            and(
              eq(PartTable.session_id, input.sessionID),
              eq(PartTable.message_id, input.messageID),
              eq(PartTable.id, input.partID),
            ),
          )
          .get(),
      )
      if (!row) return
      return {
        ...row.data,
        id: row.id,
        sessionID: row.session_id,
        messageID: row.message_id,
      } as MessageV2.Part
    })

    const create = Effect.fn("Session.create")(function* (input?: {
      parentID?: SessionID
      title?: string
      skill?: string
      permission?: Permission.Ruleset
      workspaceID?: WorkspaceID
      createdByAgentTool?: boolean
      subagentType?: string | null
    }) {
      const directory = yield* InstanceState.directory
      const workspace = yield* InstanceState.workspaceID
      return yield* createNext({
        parentID: input?.parentID,
        directory,
        title: input?.title,
        skill: input?.skill,
        permission: input?.permission,
        workspaceID: input?.workspaceID ?? (workspace as WorkspaceID | undefined),
        createdByAgentTool: input?.createdByAgentTool,
        subagentType: input?.subagentType,
      })
    })

    const fork = Effect.fn("Session.fork")(function* (input: { sessionID: SessionID; messageID?: MessageID }) {
      const directory = yield* InstanceState.directory
      const original = yield* get(input.sessionID)
      const title = getForkedTitle(original.title)
      const session = yield* createNext({
        directory,
        workspaceID: original.workspaceID,
        title,
        skill: original.skill,
        executionContext: original.executionContext,
      })
      const msgs = yield* messages({ sessionID: input.sessionID })
      const idMap = new Map<string, MessageID>()

      for (const msg of msgs) {
        if (input.messageID && msg.info.id >= input.messageID) break
        const newID = MessageID.ascending()
        idMap.set(msg.info.id, newID)

        const parentID = msg.info.role === "assistant" && msg.info.parentID ? idMap.get(msg.info.parentID) : undefined
        const cloned = yield* updateMessage({
          ...msg.info,
          sessionID: session.id,
          id: newID,
          ...(parentID && { parentID }),
        })

        for (const part of msg.parts) {
          yield* updatePart({
            ...part,
            id: PartID.ascending(),
            messageID: cloned.id,
            sessionID: session.id,
          })
        }
      }
      return session
    })

    const patch = (sessionID: SessionID, info: Patch) =>
      Effect.sync(() => SyncEvent.run(Event.Updated, { sessionID, info }))

    const touch = Effect.fn("Session.touch")(function* (sessionID: SessionID) {
      yield* patch(sessionID, { time: { updated: Date.now() } })
    })

    const setTitle = Effect.fn("Session.setTitle")(function* (input: { sessionID: SessionID; title: string }) {
      yield* patch(input.sessionID, { title: input.title })
    })

    const setArchived = Effect.fn("Session.setArchived")(function* (input: { sessionID: SessionID; time?: number }) {
      yield* patch(input.sessionID, { time: { archived: input.time } })
    })

    const setPermission = Effect.fn("Session.setPermission")(function* (input: {
      sessionID: SessionID
      permission: Permission.Ruleset
    }) {
      yield* patch(input.sessionID, { permission: input.permission, time: { updated: Date.now() } })
    })

    const setRevert = Effect.fn("Session.setRevert")(function* (input: {
      sessionID: SessionID
      revert: Info["revert"]
      summary: Info["summary"]
    }) {
      yield* patch(input.sessionID, { summary: input.summary, time: { updated: Date.now() }, revert: input.revert })
    })

    const clearRevert = Effect.fn("Session.clearRevert")(function* (sessionID: SessionID) {
      yield* patch(sessionID, { time: { updated: Date.now() }, revert: null })
    })

    const setSummary = Effect.fn("Session.setSummary")(function* (input: {
      sessionID: SessionID
      summary: Info["summary"]
    }) {
      yield* patch(input.sessionID, { time: { updated: Date.now() }, summary: input.summary })
    })

    const updateExecutionContext = Effect.fn("Session.updateExecutionContext")(function* (input: {
      sessionID: SessionID
      activeDirectory?: string
      activeWorktree?: SessionExecutionContext["activeWorktree"] | null
    }) {
      const current = yield* get(input.sessionID)
      const now = Date.now()
      const hasActiveWorktree = input.activeWorktree !== undefined
      const ownerDirectory = canonicalDirectory(current.executionContext.ownerDirectory)
      const activeDirectoryInput = hasActiveWorktree
        ? (input.activeWorktree?.directory ?? ownerDirectory)
        : (input.activeDirectory ?? current.executionContext.activeDirectory)
      const activeDirectory = canonicalDirectory(activeDirectoryInput)
      const activeWorktree = hasActiveWorktree
        ? input.activeWorktree
          ? { ...input.activeWorktree, directory: canonicalDirectory(input.activeWorktree.directory) }
          : undefined
        : sameDirectory(activeDirectory, ownerDirectory)
          ? undefined
          : current.executionContext.activeWorktree
            ? {
                ...current.executionContext.activeWorktree,
                directory: canonicalDirectory(current.executionContext.activeWorktree.directory),
              }
            : undefined
      const next: SessionExecutionContext = {
        ownerDirectory,
        activeDirectory,
        activeWorktree,
        lastChangedAt: now,
      }
      yield* patch(input.sessionID, { time: { updated: now }, executionContext: next })
      return { ...current, executionContext: next, time: { ...current.time, updated: now } }
    })

    const findActiveWorktreeBinding = Effect.fn("Session.findActiveWorktreeBinding")(function* (directory: string) {
      const project = Instance.project
      const target = canonicalDirectory(directory)
      const rows = yield* db((d) =>
        d
          .select()
          .from(SessionTable)
          .where(
            and(
              eq(SessionTable.project_id, project.id),
              sql`${SessionTable.execution_context} IS NOT NULL`,
              sql`json_extract(${SessionTable.execution_context}, '$.activeDirectory') != json_extract(${SessionTable.execution_context}, '$.ownerDirectory')`,
            ),
          )
          .all(),
      )
      const ids = [...new Set(rows.filter(needsProjectFallback).map((row) => row.project_id))]
      const projects = new Map<string, ProjectFallback>()
      if (ids.length > 0) {
        const items = yield* db((d) =>
          d
            .select({ id: ProjectTable.id, worktree: ProjectTable.worktree, vcs: ProjectTable.vcs })
            .from(ProjectTable)
            .where(inArray(ProjectTable.id, ids))
            .all(),
        )
        for (const item of items) projects.set(item.id, item)
      }
      for (const row of rows) {
        const session = fromRow(row, projects.get(row.project_id))
        const exec = session.executionContext
        if (sameDirectory(exec.activeDirectory, exec.ownerDirectory)) continue
        if (
          sameDirectory(exec.activeDirectory, target) ||
          (exec.activeWorktree?.directory && sameDirectory(exec.activeWorktree.directory, target))
        ) {
          return session
        }
      }
      return undefined
    })

    const diff = Effect.fn("Session.diff")(function* (sessionID: SessionID) {
      return yield* storage
        .read<Snapshot.FileDiff[]>(["session_diff", sessionID])
        .pipe(Effect.orElseSucceed((): Snapshot.FileDiff[] => []))
    })

    const messages = Effect.fn("Session.messages")(function* (input: { sessionID: SessionID; limit?: number }) {
      if (input.limit) {
        return MessageV2.page({ sessionID: input.sessionID, limit: input.limit }).items
      }
      return Array.from(MessageV2.stream(input.sessionID)).reverse()
    })

    const removeMessage = Effect.fn("Session.removeMessage")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
    }) {
      yield* Effect.sync(() =>
        SyncEvent.run(MessageV2.Event.Removed, {
          sessionID: input.sessionID,
          messageID: input.messageID,
        }),
      )
      return input.messageID
    })

    const removePart = Effect.fn("Session.removePart")(function* (input: {
      sessionID: SessionID
      messageID: MessageID
      partID: PartID
    }) {
      yield* Effect.sync(() =>
        SyncEvent.run(MessageV2.Event.PartRemoved, {
          sessionID: input.sessionID,
          messageID: input.messageID,
          partID: input.partID,
        }),
      )
      return input.partID
    })

    const updatePartDelta = Effect.fnUntraced(function* (input: {
      sessionID: SessionID
      messageID: MessageID
      partID: PartID
      field: string
      delta: string
    }) {
      yield* bus.publish(MessageV2.Event.PartDelta, input)
    })

    /** Finds the first message matching the predicate, searching newest-first. */
    const findMessage = Effect.fn("Session.findMessage")(function* (
      sessionID: SessionID,
      predicate: (msg: MessageV2.WithParts) => boolean,
    ) {
      for (const item of MessageV2.stream(sessionID)) {
        if (predicate(item)) return Option.some(item)
      }
      return Option.none<MessageV2.WithParts>()
    })

    return Service.of({
      create,
      fork,
      touch,
      get,
      setTitle,
      setArchived,
      setPermission,
      setRevert,
      clearRevert,
      setSummary,
      updateExecutionContext,
      findActiveWorktreeBinding,
      diff,
      messages,
      children,
      remove,
      updateMessage,
      removeMessage,
      removePart,
      updatePart,
      getPart,
      updatePartDelta,
      findMessage,
    })
  }),
)

export const defaultLayer: Layer.Layer<Service, never, never> = layer.pipe(
  Layer.provide(Bus.layer),
  Layer.provide(Storage.defaultLayer),
)

const { runPromise } = makeRuntime(Service, defaultLayer)

export const create = fn(CreateInput, (input) => runPromise((svc) => svc.create(input)))
export const get = fn(GetInput, (input) => runPromise((svc) => svc.get(input)))
export const children = fn(ChildrenInput, (input) => runPromise((svc) => svc.children(input)))
export const fork = fn(ForkInput, (input) => runPromise((svc) => svc.fork(input)))
export const remove = fn(RemoveInput, (input) => runPromise((svc) => svc.remove(input)))
export const setTitle = fn(SetTitleInput, (input) => runPromise((svc) => svc.setTitle(input)))
export const setArchived = fn(SetArchivedInput, (input) => runPromise((svc) => svc.setArchived(input)))
export const setPermission = fn(SetPermissionInput, (input) => runPromise((svc) => svc.setPermission(input)))
export const messages = fn(MessagesInput, (input) => runPromise((svc) => svc.messages(input)))
export const removePart = fn(RemovePartInput, (input) => runPromise((svc) => svc.removePart(input)))
export const updateMessage = fn(MessageV2.Info, (input) => runPromise((svc) => svc.updateMessage(input)))
export const updatePart = fn(MessageV2.Part, (input) => runPromise((svc) => svc.updatePart(input)))
export const updateExecutionContext = fn(UpdateExecutionContextInput, (input) =>
  runPromise((svc) => svc.updateExecutionContext(input)),
)
export const findActiveWorktreeBinding = fn(FindActiveWorktreeBindingInput, (directory) =>
  runPromise((svc) => svc.findActiveWorktreeBinding(directory)),
)

type ListSort = "updated" | "created"
type GlobalListCursor =
  | number
  | {
      created: number
      id: SessionID
    }

function sessionOrder(sort: ListSort) {
  return sort === "created"
    ? [desc(SessionTable.time_created), asc(SessionTable.id)]
    : [desc(SessionTable.time_updated), desc(SessionTable.id)]
}

export function* list(input?: {
  directory?: string
  workspaceID?: WorkspaceID
  roots?: boolean
  start?: number
  search?: string
  limit?: number
  sort?: ListSort
}) {
  const project = Instance.project
  const conditions = [eq(SessionTable.project_id, project.id)]

  if (input?.workspaceID) {
    conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
  }
  if (!Flag.OPENCODE_EXPERIMENTAL_WORKSPACES) {
    if (input?.directory) {
      conditions.push(eq(SessionTable.directory, input.directory))
    }
  }
  if (input?.roots) {
    conditions.push(isNull(SessionTable.parent_id))
  }
  if (input?.start) {
    conditions.push(gte(SessionTable.time_updated, input.start))
  }
  if (input?.search) {
    conditions.push(like(SessionTable.title, `%${input.search}%`))
  }

  const limit = input?.limit ?? 100
  const sort = input?.sort ?? "updated"
  const order = sessionOrder(sort)

  const rows = Database.use((db) =>
    db
      .select()
      .from(SessionTable)
      .where(and(...conditions))
      .orderBy(...order)
      .limit(limit)
      .all(),
  )
  const ids = [...new Set(rows.filter(needsProjectFallback).map((row) => row.project_id))]
  const projects = new Map<string, ProjectFallback>()
  if (ids.length > 0) {
    const items = Database.use((db) =>
      db
        .select({ id: ProjectTable.id, worktree: ProjectTable.worktree, vcs: ProjectTable.vcs })
        .from(ProjectTable)
        .where(inArray(ProjectTable.id, ids))
        .all(),
    )
    for (const item of items) projects.set(item.id, item)
  }
  for (const row of rows) {
    yield fromRow(row, projects.get(row.project_id))
  }
}

export function* listGlobal(input?: {
  directory?: string
  roots?: boolean
  start?: number
  cursor?: GlobalListCursor
  search?: string
  limit?: number
  archived?: boolean
  sort?: ListSort
}) {
  const conditions: SQL[] = []
  const sort = input?.sort ?? "updated"

  if (input?.directory) {
    conditions.push(eq(SessionTable.directory, input.directory))
  }
  if (input?.roots) {
    conditions.push(isNull(SessionTable.parent_id))
  }
  if (input?.start) {
    conditions.push(gte(SessionTable.time_updated, input.start))
  }
  if (input?.cursor !== undefined) {
    if (sort === "created") {
      if (typeof input.cursor !== "number") {
        conditions.push(
          or(
            lt(SessionTable.time_created, input.cursor.created),
            and(eq(SessionTable.time_created, input.cursor.created), gt(SessionTable.id, input.cursor.id)),
          )!,
        )
      } else {
        // Numeric cursors are invalid for created-order pagination and are ignored.
      }
    } else {
      const cursor = typeof input.cursor === "number" ? input.cursor : input.cursor.created
      conditions.push(lt(SessionTable.time_updated, cursor))
    }
  }
  if (input?.search) {
    conditions.push(like(SessionTable.title, `%${input.search}%`))
  }
  if (!input?.archived) {
    conditions.push(isNull(SessionTable.time_archived))
  }

  const limit = input?.limit ?? 100

  const rows = Database.use((db) => {
    const query =
      conditions.length > 0
        ? db
            .select()
            .from(SessionTable)
            .where(and(...conditions))
        : db.select().from(SessionTable)
    const order = sessionOrder(sort)
    return query
      .orderBy(...order)
      .limit(limit)
      .all()
  })

  const ids = [...new Set(rows.map((row) => row.project_id))]
  const projects = new Map<string, ProjectInfo>()
  const projectFallbacks = new Map<string, ProjectFallback>()

  if (ids.length > 0) {
    const items = Database.use((db) =>
      db
        .select({
          id: ProjectTable.id,
          name: ProjectTable.name,
          worktree: ProjectTable.worktree,
          vcs: ProjectTable.vcs,
        })
        .from(ProjectTable)
        .where(inArray(ProjectTable.id, ids))
        .all(),
    )
    for (const item of items) {
      projects.set(item.id, {
        id: item.id,
        name: item.name ?? undefined,
        worktree: item.worktree,
      })
      projectFallbacks.set(item.id, item)
    }
  }

  for (const row of rows) {
    const project = projects.get(row.project_id) ?? null
    yield { ...fromRow(row, projectFallbacks.get(row.project_id)), project }
  }
}
