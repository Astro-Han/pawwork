import z from "zod"
import { Context as EffectContext, Effect, Layer } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Identifier } from "@/id/id"
import { Instance } from "@/project/instance"
import { ProjectID } from "@/project/schema"
import { PermissionID } from "@/permission/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { SessionID } from "@/session/schema"
import { and, Database, desc, eq, gte, inArray, lt, NotFoundError, or, sql } from "@/storage/db"
import { Flock } from "@/util/flock"
import type { AutomationRunAttendance, AutomationRunBlocker } from "./run-context"
import { AutomationDefinitionTable, AutomationRunTable } from "./automation.sql"
import { isValidCronExpression as cronIsValidExpression } from "./cron"
import { computeDerivedFields } from "./derived"
import { internalTestHooks } from "./__test_hooks"

export const AutomationID = {
  Definition: {
    zod: Identifier.schema("automation"),
    ascending: (id?: string) => Identifier.ascending("automation", id),
  },
  Run: {
    zod: Identifier.schema("automation_run"),
    ascending: (id?: string) => Identifier.ascending("automation_run", id),
  },
}

export namespace Automation {
  export const MIN_INTERVAL_MS = 30_000
  export const MAX_TITLE_CHARS = 160
  export const MAX_PROMPT_CHARS = 20_000
  export const MAX_CONDITION_CHARS = 4_000

  export const DefinitionID = AutomationID.Definition.zod
  export const RunID = AutomationID.Run.zod

  export const Context = z.enum(["continue", "fresh"])
  export const Where = z
    .object({ projectID: ProjectID.zod, worktree: z.string().min(1).optional() })
    .strict()
    .meta({
      ref: "AutomationWhere",
    })
  export const Model = z
    .object({ providerID: ProviderID.zod, modelID: ModelID.zod })
    .strict()
    .meta({ ref: "AutomationModel" })
  export type Model = z.infer<typeof Model>
  export const ValidationErrorDetail = z
    .object({ field: z.string(), message: z.string() })
    .strict()
    .meta({ ref: "AutomationValidationErrorDetail" })
  export type ValidationErrorDetail = z.infer<typeof ValidationErrorDetail>
  export type ValidationErrorDetailType = ValidationErrorDetail
  export const ValidationErrorResponse = z
    .object({ error: z.literal("invalid_automation"), details: z.array(ValidationErrorDetail) })
    .strict()
    .meta({ ref: "AutomationValidationError" })
  export const ConflictErrorResponse = z
    .object({ error: z.literal("automation_conflict"), message: z.string() })
    .strict()
    .meta({ ref: "AutomationConflictError" })
  export const ActiveRunStillRunningErrorResponse = z
    .object({ error: z.literal("active_run_still_running"), runID: RunID })
    .strict()
    .meta({ ref: "AutomationActiveRunStillRunningError" })
  // Stop accepts all three kinds at the schema layer so create/update can
  // return a structured `unsupported_stop_condition` error for `kind: "condition"`
  // (rejected by validateCreateInput / validateUpdateInput). The agent-facing
  // `automate` tool schema separately omits condition from its input surface.
  export const Stop = z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("count"), count: z.number().int().positive() }).strict(),
      z.object({ kind: z.literal("condition"), condition: z.string().min(1).max(MAX_CONDITION_CHARS, `condition_too_long_${MAX_CONDITION_CHARS}`) }).strict(),
      z.object({ kind: z.literal("never") }).strict(),
    ])
    .meta({ ref: "AutomationStop" })
  export const Rhythm = z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("interval"), everyMs: z.number().int().min(MIN_INTERVAL_MS, `interval_below_minimum_${MIN_INTERVAL_MS}ms`) }).strict(),
      z.object({ kind: z.literal("cron"), expression: z.string().min(1) }).strict(),
    ])
    .meta({ ref: "AutomationRhythm" })

  const CommonCreate = {
    title: z.string().min(1).max(MAX_TITLE_CHARS, `title_too_long_${MAX_TITLE_CHARS}`),
    prompt: z.string().min(1).max(MAX_PROMPT_CHARS, `prompt_too_long_${MAX_PROMPT_CHARS}`),
    context: Context,
    where: Where,
    timezone: z.string().min(1),
    model: Model,
    variant: z.string().min(1).optional(),
  }

  export const CreateInput = z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("oneshot"), ...CommonCreate, fireAt: z.number().int().nonnegative() }).strict(),
      z.object({ kind: z.literal("recurring"), ...CommonCreate, rhythm: Rhythm, stop: Stop }).strict(),
    ])
    .meta({ ref: "AutomationCreateInput" })
  export type CreateInput = z.infer<typeof CreateInput>

  export const UpdateInput = z
    .object({
      title: z.string().min(1).max(MAX_TITLE_CHARS, `title_too_long_${MAX_TITLE_CHARS}`).optional(),
      prompt: z.string().min(1).max(MAX_PROMPT_CHARS, `prompt_too_long_${MAX_PROMPT_CHARS}`).optional(),
      paused: z.boolean().optional(),
      context: Context.optional(),
      where: Where.optional(),
      timezone: z.string().min(1).optional(),
      fireAt: z.number().int().nonnegative().optional(),
      rhythm: Rhythm.optional(),
      stop: Stop.optional(),
      model: Model.optional(),
      variant: z.string().min(1).nullable().optional(),
    })
    .strict()
    .meta({ ref: "AutomationUpdateInput" })
  export type UpdateInput = z.infer<typeof UpdateInput>

  const CommonDefinition = {
    id: DefinitionID,
    title: z.string().min(1).max(MAX_TITLE_CHARS, `title_too_long_${MAX_TITLE_CHARS}`),
    prompt: z.string().min(1).max(MAX_PROMPT_CHARS, `prompt_too_long_${MAX_PROMPT_CHARS}`),
    revision: z.number().int().positive(),
    paused: z.boolean(),
    context: Context,
    where: Where,
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    timezone: z.string().min(1),
    sourceSessionID: SessionID.zod.optional(),
    normalizationWarnings: z.array(z.string()),
    model: Model,
    variant: z.string().min(1).optional(),
  }

  export const Definition = z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("oneshot"), ...CommonDefinition, fireAt: z.number().int().nonnegative() }).strict(),
      z.object({
        kind: z.literal("recurring"),
        ...CommonDefinition,
        rhythm: Rhythm,
        stop: Stop,
        nextFireAt: z.number().int().nonnegative().nullable(),
        nextFires: z.array(z.number().int().nonnegative()),
        failureStreak: z.number().int().nonnegative(),
      }).strict(),
    ])
    .meta({ ref: "AutomationDefinition" })
  export type Definition = z.infer<typeof Definition>

  export type Scope = {
    projectID: ProjectID
    ownerDirectory: string
  }

  export type ScopedDefinition = {
    definition: Definition
    scope: Scope
  }

  export const Tombstone = z
    .object({ id: DefinitionID, deleted: z.literal(true), revision: z.number().int().positive() })
    .strict()
    .meta({ ref: "AutomationDefinitionTombstone" })
  export type Tombstone = z.infer<typeof Tombstone>

  export const Blocker = z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("permission"), requestID: PermissionID.zod }).strict(),
      z.object({ kind: z.literal("question"), callID: z.string().min(1) }).strict(),
    ])
    .meta({ ref: "AutomationRunBlocker" })
  export const Error = z
    .object({
      code: z.enum(["needs_user_input", "execution_failed", "step_cap", "loop_gate"]),
      message: z.string(),
    })
    .strict()
    .meta({ ref: "AutomationRunError" })
  const CommonRun = {
    id: RunID,
    automationID: DefinitionID,
    revision: z.number().int().positive(),
    definitionRevision: z.number().int().positive(),
    triggeredAt: z.number().int().nonnegative(),
    cost: z.number().nonnegative().nullable(),
  }
  const RunningRun = {
    ...CommonRun,
    sessionID: SessionID.zod,
    startedAt: z.number().int().nonnegative(),
    completedAt: z.null(),
    result: z.null(),
    error: z.null(),
  }
  export const Run = z
    .discriminatedUnion("state", [
      z.object({
        ...CommonRun,
        state: z.literal("scheduled"),
        sessionID: SessionID.zod.nullable(),
        startedAt: z.null(),
        completedAt: z.null(),
        result: z.null(),
        error: z.null(),
      }).strict(),
      z.object({
        ...RunningRun,
        state: z.literal("running"),
      }).strict(),
      z.object({
        ...RunningRun,
        state: z.literal("awaiting_input"),
        blocker: Blocker,
      }).strict(),
      z.object({
        ...RunningRun,
        state: z.literal("succeeded"),
        completedAt: z.number().int().nonnegative(),
        result: z.string().nullable(),
      }).strict(),
      z.object({
        ...RunningRun,
        state: z.literal("failed"),
        completedAt: z.number().int().nonnegative(),
        error: Error,
      }).strict(),
      z.object({
        ...CommonRun,
        state: z.literal("stopped"),
        sessionID: SessionID.zod.nullable(),
        startedAt: z.number().int().nonnegative().nullable(),
        completedAt: z.number().int().nonnegative(),
        result: z.null(),
        error: z.null(),
        stopReason: z.enum(["previous_run_awaiting_input", "missed_schedule", "cancelled", "expired", "blocker_lost"]),
      }).strict(),
    ])
    .superRefine((run, ctx) => {
      if (run.startedAt !== null && run.startedAt < run.triggeredAt) {
        ctx.addIssue({ code: "custom", path: ["startedAt"], message: "startedAt must be greater than or equal to triggeredAt" })
      }
      if (run.completedAt !== null && run.startedAt !== null && run.completedAt < run.startedAt) {
        ctx.addIssue({ code: "custom", path: ["completedAt"], message: "completedAt must be greater than or equal to startedAt" })
      }
      if (run.completedAt !== null && run.completedAt < run.triggeredAt) {
        ctx.addIssue({ code: "custom", path: ["completedAt"], message: "completedAt must be greater than or equal to triggeredAt" })
      }
      if (run.state === "stopped" && ((run.sessionID === null) !== (run.startedAt === null))) {
        ctx.addIssue({ code: "custom", path: ["sessionID"], message: "stopped requires sessionID and startedAt to be both present or both null" })
      }
    })
    .meta({ ref: "AutomationRun" })
  export type Run = z.infer<typeof Run>

  export const ListResponse = z.object({ items: z.array(Definition) }).strict().meta({ ref: "AutomationListResponse" })
  export const RunsResponse = z
    .object({ items: z.array(Run), nextCursor: RunID.nullable() })
    .strict()
    .meta({ ref: "AutomationRunsResponse" })

  export const Event = {
    DefinitionUpdated: BusEvent.define("automation.definition.updated", Definition),
    DefinitionDeleted: BusEvent.define("automation.definition.deleted", Tombstone),
    RunUpdated: BusEvent.define("automation.run.updated", Run),
  }

  type State = {
    activeWriters: Set<string>
    activeRuns: Map<string, { writerKey: string; controller: AbortController; runID: string }>
  }
  // Per-directory execution state. The container lives in InstanceState (owned by the
  // Service layer below); the sync facade reads it through a runtime bridge (see `state`).
  function state(): State {
    return automationRuntime.runSync((svc) => svc.activeState())
  }

  export type RunExecutor = (input: {
    definition: Definition
    run: Run
    attendance: AutomationRunAttendance
    signal: AbortSignal
  }) => Promise<{ sessionID: SessionID; result: string | null; cost?: number | null }>

  const COMMON_CREATE_FIELDS = new Set([
    "kind",
    "title",
    "prompt",
    "context",
    "where",
    "timezone",
    "model",
    "variant",
  ])
  const ONESHOT_CREATE_FIELDS = new Set([...COMMON_CREATE_FIELDS, "fireAt"])
  const RECURRING_CREATE_FIELDS = new Set([...COMMON_CREATE_FIELDS, "rhythm", "stop"])
  const UPDATE_FIELDS = new Set([
    "title",
    "prompt",
    "paused",
    "context",
    "where",
    "timezone",
    "fireAt",
    "rhythm",
    "stop",
    "model",
    "variant",
  ])

  function addDetail(details: ValidationErrorDetail[], field: string, message: string) {
    details.push({ field, message })
  }

  export function normalizeWorktreePlacement(input: string) {
    const slug = input
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
    return slug.length > 0 && slug.length <= 40 ? slug : undefined
  }

  function normalizeWhere<T extends { projectID: ProjectID; worktree?: string }>(where: T): T {
    if (!where.worktree) return where
    const worktree = normalizeWorktreePlacement(where.worktree)
    if (!worktree) return where
    return { ...where, worktree }
  }

  function normalizeDefinitionInput<T extends CreateInput | Definition>(input: T): T {
    return { ...input, where: normalizeWhere(input.where) } as T
  }

  function normalizeUpdateInput(input: UpdateInput): UpdateInput {
    if (!input.where) return input
    return { ...input, where: normalizeWhere(input.where) }
  }

  export function currentScope(): Scope {
    return { projectID: Instance.project.id, ownerDirectory: Instance.directory }
  }

  function rowScope(row: Pick<typeof AutomationDefinitionTable.$inferSelect, "project_id" | "owner_directory">): Scope {
    return { projectID: row.project_id, ownerDirectory: row.owner_directory }
  }

  function scopeMatches(row: Pick<typeof AutomationDefinitionTable.$inferSelect, "project_id" | "owner_directory">, scope: Scope) {
    return row.project_id === scope.projectID && row.owner_directory === scope.ownerDirectory
  }

  export function getWriterKey(definition: Definition) {
    return definition.where.worktree ?? definition.where.projectID
  }

  function rejectUnknownFields(
    input: Record<string, unknown>,
    allowed: Set<string>,
    details: ValidationErrorDetail[],
  ) {
    for (const field of Object.keys(input)) {
      if (allowed.has(field)) continue
      if (details.some((detail) => detail.field === field)) continue
      addDetail(details, field, "unsupported_automation_field")
    }
  }

  export function isValidTimezone(timezone: string) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(0)
      return true
    } catch {
      return false
    }
  }

  export const isValidCronExpression = cronIsValidExpression

  function validateScheduleFields(input: CreateInput | Definition) {
    const details: ValidationErrorDetail[] = []
    if (!isValidTimezone(input.timezone)) addDetail(details, "timezone", "invalid_timezone")
    if (input.kind === "recurring" && input.rhythm.kind === "cron" && !isValidCronExpression(input.rhythm.expression)) {
      addDetail(details, "rhythm.expression", "invalid_cron_expression")
    }
    return details
  }

  export function validateCreateInput(input: CreateInput | Definition, projectID = Instance.project.id, now?: number) {
    const details: ValidationErrorDetail[] = []
    const isDefinition = Object.hasOwn(input, "id")
    if (!isDefinition) {
      if (input.kind === "oneshot") {
        if (Object.hasOwn(input, "rhythm")) addDetail(details, "rhythm", "unsupported_for_oneshot_automation")
        if (Object.hasOwn(input, "stop")) addDetail(details, "stop", "unsupported_for_oneshot_automation")
        if (now !== undefined && input.fireAt <= now) addDetail(details, "fireAt", "fireAt_must_be_future")
        rejectUnknownFields(input, ONESHOT_CREATE_FIELDS, details)
      } else {
        if (Object.hasOwn(input, "fireAt")) addDetail(details, "fireAt", "unsupported_for_recurring_automation")
        rejectUnknownFields(input, RECURRING_CREATE_FIELDS, details)
      }
    }
    if (input.where.projectID !== projectID) {
      addDetail(details, "where.projectID", "Automation must target the current project.")
    }
    if (input.where.worktree && !normalizeWorktreePlacement(input.where.worktree)) {
      addDetail(details, "where.worktree", "invalid_worktree_placement")
    }
    if (input.where.worktree && input.context === "continue") {
      addDetail(details, "context", "unsupported_continue_with_worktree")
    }
    if (input.where.worktree && Instance.project.vcs !== "git") {
      addDetail(details, "where.worktree", "unsupported_where_worktree_not_git")
    }
    if (input.kind === "recurring" && input.stop.kind === "condition") {
      addDetail(details, "stop", "unsupported_stop_condition")
    }
    details.push(...validateScheduleFields(input))
    return details
  }

  export function validateUpdateInput(previous: Definition, patch: UpdateInput, now?: number) {
    const details: ValidationErrorDetail[] = []
    // context is fixed at creation. A continue automation is bound to the chat it
    // loops inside (sourceSessionID); the public update API has no session to bind
    // a fresh->continue switch to, and no clean way to drop the stale source on a
    // continue->fresh switch. So changing context is unsupported rather than
    // silently producing an unbindable continue or a fresh with a dangling source.
    if (patch.context !== undefined && patch.context !== previous.context) {
      addDetail(details, "context", "unsupported_context_change")
    }
    if (previous.kind === "recurring" && Object.hasOwn(patch, "fireAt")) {
      addDetail(details, "fireAt", "unsupported_for_recurring_automation")
    }
    if (previous.kind === "oneshot") {
      for (const field of ["rhythm", "stop"] as const) {
        if (Object.hasOwn(patch, field)) addDetail(details, field, "unsupported_for_oneshot_automation")
      }
      if (patch.fireAt !== undefined && now !== undefined && patch.fireAt <= now) {
        addDetail(details, "fireAt", "fireAt_must_be_future")
      }
    }
    rejectUnknownFields(patch, UPDATE_FIELDS, details)
    if (patch.timezone !== undefined && !isValidTimezone(patch.timezone)) {
      addDetail(details, "timezone", "invalid_timezone")
    }
    if (patch.rhythm?.kind === "cron" && !isValidCronExpression(patch.rhythm.expression)) {
      addDetail(details, "rhythm.expression", "invalid_cron_expression")
    }
    if (patch.stop?.kind === "condition") {
      addDetail(details, "stop", "unsupported_stop_condition")
    }
    return details
  }

  export function create(input: CreateInput, options?: { now?: number; sourceSessionID?: SessionID }): Definition {
    input = normalizeDefinitionInput(input)
    const now = options?.now ?? Date.now()
    const details = validateCreateInput(input, Instance.project.id, now)
    // A continue automation loops inside an existing conversation, so it must be
    // bound to one at creation. Only the automate tool can supply that source
    // (from its session context); the public HTTP create cannot, so reject a
    // source-less continue here instead of storing a definition the runner can
    // only fail at Run-now.
    if (input.context === "continue" && !options?.sourceSessionID) {
      addDetail(details, "context", "unsupported_continue_without_source")
    }
    if (details.length) throw new ValidationError(details)
    const base = {
      id: AutomationID.Definition.ascending(),
      title: input.title,
      prompt: input.prompt,
      revision: 1,
      paused: false,
      context: input.context,
      where: input.where,
      createdAt: now,
      updatedAt: now,
      timezone: input.timezone,
      normalizationWarnings: [],
      model: input.model,
      ...(input.variant ? { variant: input.variant } : {}),
      // sourceSessionID is the continue binding: the chat a continue automation
      // loops inside. Only continue automations carry it; a fresh one mints its
      // own session per run and records none even if a caller passes one. With
      // context fixed at creation (update() forbids changing it), the field's
      // presence always means "continue", which deleteBySourceSession and the
      // runner rely on.
      ...(options?.sourceSessionID && input.context === "continue"
        ? { sourceSessionID: options.sourceSessionID }
        : {}),
    }
    let definition: Definition =
      input.kind === "oneshot"
        ? { kind: "oneshot", ...base, fireAt: input.fireAt }
        : {
            kind: "recurring",
            ...base,
            rhythm: input.rhythm,
            stop: input.stop,
            nextFireAt: null,
            nextFires: [],
            failureStreak: 0,
          }
    if (definition.kind === "recurring") {
      const derived = computeDerivedFields(definition, now, 0)
      definition = { ...definition, nextFireAt: derived.nextFireAt, nextFires: derived.nextFires }
    }
    writeDefinition(definition)
    return definition
  }

  export function list(scope: Scope = currentScope()): Definition[] {
    return Database.use((db) =>
      db
        .select()
        .from(AutomationDefinitionTable)
        .where(
          and(
            eq(AutomationDefinitionTable.project_id, scope.projectID),
            eq(AutomationDefinitionTable.owner_directory, scope.ownerDirectory),
          ),
        )
        .orderBy(desc(AutomationDefinitionTable.time_updated), desc(AutomationDefinitionTable.id))
        .all()
        .map((row) => Definition.parse(row.data)),
    )
  }

  export function listAll(): ScopedDefinition[] {
    return Database.use((db) =>
      db
        .select()
        .from(AutomationDefinitionTable)
        .orderBy(desc(AutomationDefinitionTable.time_updated), desc(AutomationDefinitionTable.id))
        .all()
        .map((row) => ({ definition: Definition.parse(row.data), scope: rowScope(row) })),
    )
  }

  export function get(id: string): Definition {
    const definition = getOptional(id)
    if (!definition) throw new NotFoundError({ message: `Automation not found: ${id}` })
    return definition
  }

  function getOptional(id: string, scope: Scope = currentScope()): Definition | undefined {
    const row = Database.use((db) =>
      db
        .select()
        .from(AutomationDefinitionTable)
        .where(eq(AutomationDefinitionTable.id, id))
        .get(),
    )
    if (!row || !scopeMatches(row, scope)) return undefined
    return Definition.parse(row.data)
  }

  function writeDefinition(definition: Definition) {
    Database.use((db) =>
      db
        .insert(AutomationDefinitionTable)
        .values({
          id: definition.id,
          project_id: definition.where.projectID,
          owner_directory: Instance.directory,
          time_created: definition.createdAt,
          time_updated: definition.updatedAt,
          data: definition,
        })
        .run(),
    )
  }

  function replaceDefinition(previous: Definition, next: Definition) {
    return Database.transaction(
      (db) => {
        const row = db.select().from(AutomationDefinitionTable).where(eq(AutomationDefinitionTable.id, previous.id)).get()
        if (!row || row.project_id !== previous.where.projectID || row.owner_directory !== Instance.directory) {
          throw new NotFoundError({ message: `Automation not found: ${previous.id}` })
        }
        const current = Definition.parse(row.data)
        if (current.revision !== previous.revision) throw new ConflictError(previous.id)
        db.update(AutomationDefinitionTable)
          .set({
            project_id: next.where.projectID,
            owner_directory: Instance.directory,
            time_updated: next.updatedAt,
            data: next,
          })
          .where(
            and(
              eq(AutomationDefinitionTable.id, previous.id),
              sql`json_extract(${AutomationDefinitionTable.data}, '$.revision') = ${previous.revision}`,
            ),
          )
          .run()
        return next
      },
      { behavior: "immediate" },
    )
  }

  function writeRun(run: Run) {
    const definition = getOptional(run.automationID)
    if (!definition) throw new NotFoundError({ message: `Automation not found: ${run.automationID}` })
    const now = Date.now()
    Database.use((db) =>
      db
        .insert(AutomationRunTable)
        .values({
          id: run.id,
          automation_id: run.automationID,
          project_id: definition.where.projectID,
          owner_directory: Instance.directory,
          triggered_at: run.triggeredAt,
          data: run,
          time_created: now,
          time_updated: now,
        })
        .run(),
    )
  }

  function getRun(runID: string): Run | undefined {
    const projectID = Instance.project.id
    const row = Database.use((db) =>
      db.select().from(AutomationRunTable).where(eq(AutomationRunTable.id, runID)).get(),
    )
    if (!row || row.project_id !== projectID || row.owner_directory !== Instance.directory) return undefined
    return Run.parse(row.data)
  }

  function isSameValue(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true
    if (Array.isArray(left) || Array.isArray(right)) {
      if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
      return left.every((item, index) => isSameValue(item, right[index]))
    }
    if (typeof left === "object" && left && typeof right === "object" && right) {
      const leftKeys = Object.keys(left)
      const rightKeys = Object.keys(right)
      if (leftKeys.length !== rightKeys.length) return false
      return leftKeys.every((key) => Object.hasOwn(right, key) && isSameValue((left as any)[key], (right as any)[key]))
    }
    return false
  }

  function hasChanges(previous: Definition, patch: UpdateInput) {
    return Object.entries(patch).some(([field, value]) => {
      if (field === "variant" && value === null && previous.variant === undefined) return false
      return !isSameValue(previous[field as keyof Definition], value)
    })
  }

  export function update(id: string, patch: UpdateInput, options?: { now?: number }): Definition {
    const previous = get(id)
    patch = normalizeUpdateInput(patch)
    const now = options?.now ?? Date.now()
    const updateDetails = validateUpdateInput(previous, patch, now)
    if (updateDetails.length) throw new ValidationError(updateDetails)
    if (!hasChanges(previous, patch)) return previous
    const merged: Record<string, unknown> = { ...previous, ...patch }
    if (patch.variant === null) delete merged.variant
    let next = Definition.parse({
      ...merged,
      revision: previous.revision + 1,
      updatedAt: now,
    })
    const details = validateCreateInput(next)
    if (details.length) throw new ValidationError(details)
    if (next.kind === "recurring" && previous.kind === "recurring") {
      const scheduleChanged =
        !isSameValue(previous.rhythm, next.rhythm) ||
        !isSameValue(previous.stop, next.stop) ||
        previous.timezone !== next.timezone ||
        previous.paused !== next.paused
      if (scheduleChanged) {
        const derived = computeDerivedFields(next, now, completedRunCount(next.id))
        next = { ...next, nextFireAt: derived.nextFireAt, nextFires: derived.nextFires }
      }
    }
    return replaceDefinition(previous, next)
  }

  export function recordRunOutcome(
    run: Run,
    options?: {
      now?: number
      refreshOnStopped?: boolean
    },
  ): Definition | undefined {
    if (run.state !== "succeeded" && run.state !== "failed" && run.state !== "stopped") return undefined
    const now = options?.now ?? Date.now()
    // Retry on revision conflict: a concurrent write (e.g. pause/update) may
    // have advanced the row between our read and our update. Re-read the
    // latest definition and recompute failureStreak + derived fields against
    // it, otherwise we silently drop the run's outcome and the user sees a
    // stale nextFireAt / failureStreak.
    for (let attempt = 0; attempt < 3; attempt++) {
      const previous = getOptional(run.automationID)
      if (!previous || previous.kind !== "recurring") return undefined
      const failureStreak =
        run.state === "succeeded" ? 0 : run.state === "failed" ? previous.failureStreak + 1 : previous.failureStreak
      const derived =
        run.state === "stopped" && !options?.refreshOnStopped
          ? { nextFireAt: previous.nextFireAt, nextFires: previous.nextFires }
          : computeDerivedFields(previous, now, completedRunCount(previous.id))
      if (
        previous.failureStreak === failureStreak &&
        previous.nextFireAt === derived.nextFireAt &&
        sameArray(previous.nextFires, derived.nextFires)
      ) {
        return undefined
      }
      const next = Definition.parse({
        ...previous,
        failureStreak,
        nextFireAt: derived.nextFireAt,
        nextFires: derived.nextFires,
        revision: previous.revision + 1,
        updatedAt: now,
      })
      internalTestHooks.beforeReplaceDefinition?.(previous)
      try {
        return replaceDefinition(previous, next)
      } catch (error) {
        if (!(error instanceof ConflictError)) throw error
        // retry: read latest and recompute
      }
    }
    return undefined
  }

  function sameArray(left: readonly number[], right: readonly number[]) {
    if (left.length !== right.length) return false
    for (let index = 0; index < left.length; index++) {
      if (left[index] !== right[index]) return false
    }
    return true
  }

  export async function remove(id: string): Promise<{ tombstone: Tombstone; stoppedRun?: Run }> {
    const previous = get(id)
    const stoppedRun = stopActiveRun(id)
    const liveRun = await getLiveActiveRun(id)
    if (liveRun) throw new ActiveRunStillRunningError(liveRun.id)
    Database.use((db) => db.delete(AutomationDefinitionTable).where(eq(AutomationDefinitionTable.id, id)).run())
    return { tombstone: { id: previous.id, deleted: true, revision: previous.revision + 1 }, stoppedRun }
  }

  // A continue automation lives inside the conversation it was created in
  // (sourceSessionID): every run appends to that thread. When the user deletes
  // the conversation, those automations have nowhere left to run, so they are
  // removed alongside it. Fresh automations carry no sourceSessionID and never
  // cascade. Best-effort per automation: a single failure must not strand the
  // rest, and the run-time guard catches any straggler whose source is gone.
  export async function deleteBySourceSession(sessionID: SessionID): Promise<void> {
    for (const definition of list()) {
      if (definition.context !== "continue" || definition.sourceSessionID !== sessionID) continue
      try {
        const removed = await remove(definition.id)
        await Bus.publish(Event.DefinitionDeleted, removed.tombstone)
        if (removed.stoppedRun) await publishRunUpdated(removed.stoppedRun)
      } catch (error) {
        if (NotFoundError.isInstance(error) || error instanceof ActiveRunStillRunningError) continue
        throw error
      }
    }
  }

  function replaceRun(previous: Run, next: Run) {
    return Database.transaction(
      (db) => {
        const row = db.select().from(AutomationRunTable).where(eq(AutomationRunTable.id, previous.id)).get()
        if (!row || row.project_id !== Instance.project.id || row.owner_directory !== Instance.directory) return previous
        const current = Run.parse(row.data)
        if (current.revision !== previous.revision) return current
        const now = Date.now()
        db.update(AutomationRunTable)
          .set({
            automation_id: next.automationID,
            project_id: row.project_id,
            owner_directory: row.owner_directory,
            triggered_at: next.triggeredAt,
            data: next,
            time_updated: now,
          })
          .where(
            and(
              eq(AutomationRunTable.id, previous.id),
              sql`json_extract(${AutomationRunTable.data}, '$.revision') = ${previous.revision}`,
            ),
          )
          .run()
        return next
      },
      { behavior: "immediate" },
    )
  }

  function reviseRun(run: Run, patch: Record<string, unknown>): Run {
    const next = {
      ...run,
      ...patch,
      revision: run.revision + 1,
    }
    if (next.state !== "awaiting_input") delete (next as Record<string, unknown>).blocker
    if (next.state !== "stopped") delete (next as Record<string, unknown>).stopReason
    for (const [key, value] of Object.entries(next)) {
      if (value === undefined) delete (next as Record<string, unknown>)[key]
    }
    return replaceRun(run, Run.parse(next))
  }

  function stopRun(
    run: Run,
    stopReason: Extract<Run, { state: "stopped" }>["stopReason"],
    options?: { now?: number },
  ): Run {
    if (run.state === "stopped" || run.state === "succeeded" || run.state === "failed") return run
    return reviseRun(run, {
      state: "stopped",
      completedAt: options?.now ?? Date.now(),
      result: null,
      error: null,
      stopReason,
    })
  }

  function stopActiveRun(automationID: string) {
    const active = state().activeRuns.get(automationID)
    if (!active) return undefined
    active.controller.abort()
    const current = getRun(active.runID)
    return current ? stopRun(current, "cancelled") : undefined
  }

  async function getLiveActiveRun(automationID: string) {
    get(automationID)
    const projectID = Instance.project.id
    const ownerDirectory = Instance.directory
    const rows = Database.use((db) =>
      db
        .select()
        .from(AutomationRunTable)
        .where(
          and(
            eq(AutomationRunTable.automation_id, automationID),
            eq(AutomationRunTable.project_id, projectID),
            eq(AutomationRunTable.owner_directory, ownerDirectory),
            sql`json_extract(${AutomationRunTable.data}, '$.state') in ('scheduled', 'running', 'awaiting_input')`,
          ),
        )
        .all(),
    )
    for (const row of rows) {
      const run = Run.parse(row.data)
      if (!isActiveRun(run)) continue
      if (await hasLiveRunLease(run.id)) return run
    }
  }

  export function stopRunByID(
    runID: string,
    stopReason: Extract<Run, { state: "stopped" }>["stopReason"],
    options?: { now?: number },
  ): Run | undefined {
    const run = getRun(runID)
    if (!run) return undefined
    const active = state().activeRuns.get(run.automationID)
    if (active?.runID === runID) active.controller.abort()
    const stopped = stopRun(run, stopReason, options)
    return stopped === run ? undefined : stopped
  }

  export function markRunStarted(run: Run, sessionID: SessionID, options?: { now?: number }): Run {
    return reviseRun(run, {
      state: "running",
      sessionID,
      startedAt: options?.now ?? Date.now(),
      completedAt: null,
      result: null,
      error: null,
    })
  }

  export function markRunBlocked(run: Run, blocker: AutomationRunBlocker): Run {
    if (run.state !== "running" && run.state !== "awaiting_input") return run
    return reviseRun(run, {
      state: "awaiting_input",
      blocker,
    })
  }

  export function clearRunBlocker(run: Run): Run {
    if (run.state !== "awaiting_input") return run
    return reviseRun(run, {
      state: "running",
      blocker: undefined,
    })
  }

  export function runNow(id: string, options?: { now?: number; runID?: string }): Run {
    const definition = get(id)
    const run = Run.parse({
      id: options?.runID ?? AutomationID.Run.ascending(),
      automationID: id,
      revision: 1,
      definitionRevision: definition.revision,
      state: "scheduled",
      triggeredAt: options?.now ?? Date.now(),
      startedAt: null,
      completedAt: null,
      sessionID: null,
      result: null,
      error: null,
      cost: null,
    })
    writeRun(run)
    return run
  }

  export function hasActiveRun(automationID: string): boolean {
    if (state().activeRuns.has(automationID)) return true
    get(automationID)
    const projectID = Instance.project.id
    const ownerDirectory = Instance.directory
    return Boolean(
      Database.use((db) =>
        db
          .select({ id: AutomationRunTable.id })
          .from(AutomationRunTable)
          .where(
            and(
              eq(AutomationRunTable.automation_id, automationID),
              eq(AutomationRunTable.project_id, projectID),
              eq(AutomationRunTable.owner_directory, ownerDirectory),
              sql`json_extract(${AutomationRunTable.data}, '$.state') in ('scheduled', 'running', 'awaiting_input')`,
            ),
          )
          .limit(1)
          .get(),
      ),
    )
  }

  function isActiveRun(run: Run) {
    return run.state === "scheduled" || run.state === "running" || run.state === "awaiting_input"
  }

  function runLeaseKey(runID: string) {
    return `automation-run:${Instance.directory}:${runID}`
  }

  async function hasLiveRunLease(runID: string) {
    const lease = await Flock.tryAcquire(runLeaseKey(runID))
    if (!lease) return true
    await lease.release().catch(() => undefined)
    return false
  }

  function hasDurableActiveWriter(run: Run, writerKey: string) {
    const definition = get(run.automationID)
    const projectID = definition.where.projectID
    const ownerDirectory = Instance.directory
    return Database.transaction(
      (db) => {
        const rows = db
          .select()
          .from(AutomationRunTable)
          .where(
            and(
              eq(AutomationRunTable.project_id, projectID),
              eq(AutomationRunTable.owner_directory, ownerDirectory),
              sql`json_extract(${AutomationRunTable.data}, '$.state') in ('scheduled', 'running', 'awaiting_input')`,
            ),
          )
          .all()
        const automationIDs = [...new Set(rows.map((row) => row.automation_id))]
        const definitions = automationIDs.length
          ? db
              .select()
              .from(AutomationDefinitionTable)
              .where(
                and(
                  eq(AutomationDefinitionTable.project_id, projectID),
                  eq(AutomationDefinitionTable.owner_directory, ownerDirectory),
                  inArray(AutomationDefinitionTable.id, automationIDs),
                ),
              )
              .all()
          : []
        const writerKeys = new Map(
          definitions.map((row) => {
            const item = Definition.parse(row.data)
            return [item.id, getWriterKey(item)]
          }),
        )
        return rows.some((row) => {
          if (row.id === run.id) return false
          const item = Run.parse(row.data)
          if (!isActiveRun(item)) return false
          return writerKeys.get(item.automationID) === writerKey
        })
      },
      { behavior: "immediate" },
    )
  }

  export function hasRunTriggeredAtOrAfter(automationID: string, triggeredAt: number): boolean {
    get(automationID)
    const projectID = Instance.project.id
    const ownerDirectory = Instance.directory
    return Boolean(
      Database.use((db) =>
        db
          .select({ id: AutomationRunTable.id })
          .from(AutomationRunTable)
          .where(
            and(
              eq(AutomationRunTable.automation_id, automationID),
              eq(AutomationRunTable.project_id, projectID),
              eq(AutomationRunTable.owner_directory, ownerDirectory),
              gte(AutomationRunTable.triggered_at, triggeredAt),
            ),
          )
          .limit(1)
          .get(),
      ),
    )
  }

  export function completedRunCount(automationID: string): number {
    get(automationID)
    const projectID = Instance.project.id
    const ownerDirectory = Instance.directory
    const row = Database.use((db) =>
      db
        .select({ count: sql<number>`count(*)` })
        .from(AutomationRunTable)
        .where(
          and(
            eq(AutomationRunTable.automation_id, automationID),
            eq(AutomationRunTable.project_id, projectID),
            eq(AutomationRunTable.owner_directory, ownerDirectory),
            sql`json_extract(${AutomationRunTable.data}, '$.state') in ('succeeded', 'failed')`,
          ),
        )
        .get(),
    )
    return Number(row?.count ?? 0)
  }

  export async function reconcileInterruptedRuns(options?: { now?: number }): Promise<Run[]> {
    const projectID = Instance.project.id
    const ownerDirectory = Instance.directory
    const now = options?.now ?? Date.now()
    const rows = Database.use((db) =>
      db
        .select()
        .from(AutomationRunTable)
        .where(
          and(
            eq(AutomationRunTable.project_id, projectID),
            eq(AutomationRunTable.owner_directory, ownerDirectory),
            sql`json_extract(${AutomationRunTable.data}, '$.state') in ('scheduled', 'running', 'awaiting_input')`,
          ),
        )
        .all(),
    )
    const stopped: Run[] = []
    for (const row of rows) {
      const run = Run.parse(row.data)
      if (!isActiveRun(run)) continue
      const active = state().activeRuns.get(run.automationID)
      if (active?.runID === run.id) continue
      if (await hasLiveRunLease(run.id)) continue
      const next = Database.transaction(
        (db) => {
          const currentRow = db.select().from(AutomationRunTable).where(eq(AutomationRunTable.id, run.id)).get()
          if (!currentRow) return
          const current = Run.parse(currentRow.data)
          if (!isActiveRun(current)) return
          const nextData: Record<string, unknown> = {
            ...current,
            revision: current.revision + 1,
            state: "stopped",
            completedAt: now,
            result: null,
            error: null,
            stopReason: current.state === "awaiting_input" ? "blocker_lost" : "expired",
          }
          delete nextData.blocker
          const next = Run.parse(nextData)
          db.update(AutomationRunTable)
            .set({ data: next, time_updated: now })
            .where(eq(AutomationRunTable.id, next.id))
            .run()
          return next
        },
        { behavior: "immediate" },
      )
      if (next) stopped.push(next)
    }
    return stopped
  }

  export function recordStoppedRun(
    automationID: string,
    stopReason: Extract<Run, { state: "stopped" }>["stopReason"],
    options?: { now?: number; triggeredAt?: number },
  ): Run {
    const run = runNow(automationID, { now: options?.triggeredAt ?? options?.now })
    return stopRun(run, stopReason, options)
  }

  export async function runNowExecuting(
    id: string,
    options: { executor: RunExecutor; attendance?: AutomationRunAttendance; now?: number },
  ): Promise<Run> {
    const runID = AutomationID.Run.ascending()
    const lease = await Flock.acquire(runLeaseKey(runID))
    try {
      const initial = runNow(id, { now: options.now, runID })
      queueMicrotask(() => void executeRun(initial, options.executor, options.attendance ?? "attended", lease))
      return initial
    } catch (error) {
      await lease.release().catch(() => undefined)
      throw error
    }
  }

  async function executeRun(initial: Run, executor: RunExecutor, attendance: AutomationRunAttendance, lease: Flock.Lease) {
    const data = state()
    const controller = new AbortController()
    let writerKey: string | undefined
    let current = initial
    try {
      const definition = get(initial.automationID)
      writerKey = getWriterKey(definition)
      for (const run of await reconcileInterruptedRuns()) await publishRunUpdated(run)
      if (data.activeWriters.has(writerKey) || hasDurableActiveWriter(initial, writerKey)) {
        const stopped = reviseRun(initial, {
          state: "stopped",
          completedAt: Date.now(),
          stopReason: "previous_run_awaiting_input",
        })
        await publishRunUpdated(stopped)
        return
      }
      data.activeWriters.add(writerKey)
      data.activeRuns.set(initial.automationID, { writerKey, controller, runID: initial.id })
      const prepared = await executor({ definition, run: initial, attendance, signal: controller.signal })
      const latest = getRun(initial.id)
      if (!latest) return
      if (controller.signal.aborted) {
        const stopped = stopRun(latest, "cancelled")
        current = stopped
        if (stopped !== latest) await publishRunUpdated(stopped)
        return
      }
      const running = latest.state === "scheduled" ? markRunStarted(latest, prepared.sessionID) : latest
      current = running
      if (running !== latest) await publishRunUpdated(running)
      const succeeded = reviseRun(running, {
        state: "succeeded",
        completedAt: Date.now(),
        result: prepared.result,
        error: null,
        cost: prepared.cost ?? null,
      })
      current = succeeded
      await publishRunUpdated(succeeded)
    } catch (error) {
      const latest = getRun(initial.id)
      if (!latest) return
      current = latest
      if (controller.signal.aborted) {
        const stopped = stopRun(current, "cancelled")
        if (stopped !== current) await publishRunUpdated(stopped)
        return
      }
      if (current.state === "scheduled") {
        const stopped = reviseRun(current, {
          state: "stopped",
          completedAt: Date.now(),
          stopReason: "cancelled",
        })
        await publishRunUpdated(stopped)
        return
      }
      const isStepCap = error instanceof globalThis.Error && error.name === "AutomationStepCapError"
      const failed = reviseRun(current, {
        state: "failed",
        completedAt: Date.now(),
        error: {
          code: isStepCap ? "step_cap" : "execution_failed",
          message: error instanceof globalThis.Error ? error.message : String(error),
        },
      })
      await publishRunUpdated(failed)
    } finally {
      const active = data.activeRuns.get(initial.automationID)
      if (writerKey && active?.runID === initial.id) {
        data.activeRuns.delete(initial.automationID)
        data.activeWriters.delete(writerKey)
      }
      await lease.release().catch(() => undefined)
    }
  }

  export function runs(input: { automationID: string; limit?: number; cursor?: string }) {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100)
    get(input.automationID)
    const projectID = Instance.project.id
    const ownerDirectory = Instance.directory
    const cursorRun = input.cursor ? getRun(input.cursor) : undefined
    if (input.cursor && (!cursorRun || cursorRun.automationID !== input.automationID)) return { items: [], nextCursor: null }
    const cursorPredicate = cursorRun
      ? or(
          lt(AutomationRunTable.triggered_at, cursorRun.triggeredAt),
          and(eq(AutomationRunTable.triggered_at, cursorRun.triggeredAt), lt(AutomationRunTable.id, cursorRun.id)),
        )
      : undefined
    const page = Database.use((db) =>
      db
        .select()
        .from(AutomationRunTable)
        .where(
          and(
            eq(AutomationRunTable.automation_id, input.automationID),
            eq(AutomationRunTable.project_id, projectID),
            eq(AutomationRunTable.owner_directory, ownerDirectory),
            cursorPredicate,
          ),
        )
        .orderBy(desc(AutomationRunTable.triggered_at), desc(AutomationRunTable.id))
        .limit(limit + 1)
        .all()
        .map((row) => Run.parse(row.data)),
    )
    const items = page.slice(0, limit)
    return { items, nextCursor: page.length > limit ? items.at(-1)?.id ?? null : null }
  }

  export const publishDefinitionUpdated = (definition: Definition) => Bus.publish(Event.DefinitionUpdated, definition)
  export const publishRunUpdated = (run: Run) => Bus.publish(Event.RunUpdated, run)

  export interface Interface {
    readonly list: () => Effect.Effect<Definition[]>
    readonly get: (id: string) => Effect.Effect<Definition>
    readonly create: (
      input: CreateInput,
      options?: { now?: number; sourceSessionID?: SessionID },
    ) => Effect.Effect<Definition, ValidationError>
    readonly update: (
      id: string,
      patch: UpdateInput,
      options?: { now?: number },
    ) => Effect.Effect<Definition, ValidationError | ConflictError>
    readonly remove: (
      id: string,
    ) => Effect.Effect<{ tombstone: Tombstone; stoppedRun?: Run }, ActiveRunStillRunningError>
    readonly runNowExecuting: (
      id: string,
      options: { executor: RunExecutor; attendance?: AutomationRunAttendance; now?: number },
    ) => Effect.Effect<Run>
    readonly runs: (input: {
      automationID: string
      limit?: number
      cursor?: string
    }) => Effect.Effect<z.infer<typeof RunsResponse>>
    readonly publishDefinitionUpdated: (definition: Definition) => Effect.Effect<void>
    readonly publishDefinitionDeleted: (tombstone: Tombstone) => Effect.Effect<void>
    readonly publishRunUpdated: (run: Run) => Effect.Effect<void>
    // Execution-face: the per-directory mutable active-run/writer state, owned by InstanceState.
    readonly activeState: () => Effect.Effect<State>
  }

  export class Service extends EffectContext.Service<Service, Interface>()("@opencode/Automation") {}

  export const layer: Layer.Layer<Service> = Layer.effect(
    Service,
    Effect.gen(function* () {
      const activeStateHandle = yield* InstanceState.make<State>(() =>
        Effect.sync(() => ({ activeWriters: new Set<string>(), activeRuns: new Map() })),
      )
      return Service.of({
        list: () => Effect.sync(() => list()),
        get: (id) => Effect.sync(() => get(id)),
        create: (input, options) =>
          Effect.try({
            try: () => create(input, options),
            catch: (error) => {
              if (error instanceof ValidationError) return error
              throw error
            },
          }),
        update: (id, patch, options) =>
          Effect.try({
            try: () => update(id, patch, options),
            catch: (error) => {
              if (error instanceof ValidationError || error instanceof ConflictError) return error
              throw error
            },
          }),
        remove: (id) =>
          Effect.tryPromise({ try: () => remove(id), catch: (error) => error }).pipe(
            Effect.catch((error) =>
              error instanceof ActiveRunStillRunningError ? Effect.fail(error) : Effect.die(error),
            ),
          ),
        runNowExecuting: (id, options) => Effect.promise(() => runNowExecuting(id, options)),
        runs: (input) => Effect.sync(() => runs(input)),
        publishDefinitionUpdated: (definition) => Effect.promise(() => publishDefinitionUpdated(definition)),
        publishDefinitionDeleted: (tombstone) => Effect.promise(() => Bus.publish(Event.DefinitionDeleted, tombstone)),
        publishRunUpdated: (run) => Effect.promise(() => publishRunUpdated(run)),
        activeState: () => InstanceState.get(activeStateHandle),
      })
    }),
  )

  export const defaultLayer = layer

  const automationRuntime = makeRuntime(Service, layer)
}

export class ValidationError extends Error {
  constructor(readonly details: { field: string; message: string }[]) {
    super("Invalid automation")
    this.name = "AutomationValidationError"
  }
}

export class ConflictError extends Error {
  constructor(readonly id: string) {
    super(`Automation changed while updating: ${id}`)
    this.name = "AutomationConflictError"
  }
}

export class ActiveRunStillRunningError extends Error {
  constructor(readonly runID: string) {
    super(`Automation run is still running: ${runID}`)
    this.name = "AutomationActiveRunStillRunningError"
  }
}
