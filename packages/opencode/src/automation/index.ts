import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Identifier } from "@/id/id"
import { Instance } from "@/project/instance"
import { ProjectID } from "@/project/schema"
import { PermissionID } from "@/permission/schema"
import { SessionID } from "@/session/schema"
import { NotFoundError } from "@/storage/db"

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
  export const DefinitionID = AutomationID.Definition.zod
  export const RunID = AutomationID.Run.zod

  export const Context = z.enum(["continue", "fresh"])
  export const Where = z.object({ projectID: ProjectID.zod, worktree: z.string().min(1).optional() }).meta({
    ref: "AutomationWhere",
  })
  export const ValidationErrorDetail = z
    .object({ field: z.string(), message: z.string() })
    .meta({ ref: "AutomationValidationErrorDetail" })
  export type ValidationErrorDetail = z.infer<typeof ValidationErrorDetail>
  export const ValidationErrorResponse = z
    .object({ error: z.literal("invalid_automation"), details: z.array(ValidationErrorDetail) })
    .meta({ ref: "AutomationValidationError" })
  export const Stop = z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("count"), count: z.number().int().positive() }),
      z.object({ kind: z.literal("condition"), condition: z.string().min(1) }),
      z.object({ kind: z.literal("never") }),
    ])
    .meta({ ref: "AutomationStop" })
  export const Rhythm = z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("interval"), everyMs: z.number().int().positive() }),
      z.object({ kind: z.literal("cron"), expression: z.string().min(1) }),
    ])
    .meta({ ref: "AutomationRhythm" })

  const CommonCreate = {
    title: z.string().min(1),
    prompt: z.string().min(1),
    context: Context,
    where: Where,
    timezone: z.string().min(1),
    sourceSessionID: SessionID.zod.optional(),
    automationSessionID: SessionID.zod.optional(),
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
      title: z.string().min(1).optional(),
      prompt: z.string().min(1).optional(),
      paused: z.boolean().optional(),
      context: Context.optional(),
      where: Where.optional(),
      timezone: z.string().min(1).optional(),
      sourceSessionID: SessionID.zod.optional(),
      automationSessionID: SessionID.zod.optional(),
      fireAt: z.number().int().nonnegative().optional(),
      rhythm: Rhythm.optional(),
      stop: Stop.optional(),
    })
    .strict()
    .meta({ ref: "AutomationUpdateInput" })
  export type UpdateInput = z.infer<typeof UpdateInput>

  const CommonDefinition = {
    id: DefinitionID,
    title: z.string(),
    prompt: z.string(),
    revision: z.number().int().positive(),
    paused: z.boolean(),
    context: Context,
    where: Where,
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    timezone: z.string(),
    sourceSessionID: SessionID.zod.optional(),
    automationSessionID: SessionID.zod.optional(),
    normalizationWarnings: z.array(z.string()),
  }

  export const Definition = z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("oneshot"), ...CommonDefinition, fireAt: z.number().int().nonnegative() }),
      z.object({
        kind: z.literal("recurring"),
        ...CommonDefinition,
        rhythm: Rhythm,
        stop: Stop,
        nextFireAt: z.number().int().nonnegative().nullable(),
        nextFires: z.array(z.number().int().nonnegative()),
        failureStreak: z.number().int().nonnegative(),
      }),
    ])
    .meta({ ref: "AutomationDefinition" })
  export type Definition = z.infer<typeof Definition>

  export const Tombstone = z
    .object({ id: DefinitionID, deleted: z.literal(true), revision: z.number().int().positive() })
    .meta({ ref: "AutomationDefinitionTombstone" })
  export type Tombstone = z.infer<typeof Tombstone>

  export const Blocker = z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("permission"), sessionID: SessionID.zod, requestID: PermissionID.zod }).strict(),
      z.object({ kind: z.literal("question"), sessionID: SessionID.zod, callID: z.string().min(1) }).strict(),
    ])
    .meta({ ref: "AutomationRunBlocker" })
  export const Error = z
    .object({
      code: z.enum(["needs_user_input", "execution_failed", "unsupported_where_worktree"]),
      message: z.string(),
    })
    .meta({ ref: "AutomationRunError" })
  const CommonRun = {
    id: RunID,
    automationID: DefinitionID,
    definitionRevision: z.number().int().positive(),
    triggeredAt: z.number().int().nonnegative(),
    sessionID: SessionID.zod.nullable(),
    cost: z.number().nonnegative().nullable(),
  }
  export const Run = z
    .discriminatedUnion("state", [
      z.object({
        ...CommonRun,
        state: z.literal("scheduled"),
        startedAt: z.null(),
        completedAt: z.null(),
        result: z.null(),
        error: z.null(),
      }).strict(),
      z.object({
        ...CommonRun,
        state: z.literal("running"),
        startedAt: z.number().int().nonnegative(),
        completedAt: z.null(),
        result: z.null(),
        error: z.null(),
      }).strict(),
      z.object({
        ...CommonRun,
        state: z.literal("awaiting_input"),
        blocker: Blocker,
        startedAt: z.number().int().nonnegative(),
        completedAt: z.null(),
        result: z.null(),
        error: z.null(),
      }).strict(),
      z.object({
        ...CommonRun,
        state: z.literal("succeeded"),
        startedAt: z.number().int().nonnegative(),
        completedAt: z.number().int().nonnegative(),
        result: z.string().nullable(),
        error: z.null(),
      }).strict(),
      z.object({
        ...CommonRun,
        state: z.literal("failed"),
        startedAt: z.number().int().nonnegative(),
        completedAt: z.number().int().nonnegative(),
        result: z.null(),
        error: Error.nullable(),
        stopReason: z.enum(["step_cap", "loop_gate"]).optional(),
      }).strict(),
      z.object({
        ...CommonRun,
        state: z.literal("skipped"),
        startedAt: z.number().int().nonnegative().nullable(),
        completedAt: z.number().int().nonnegative(),
        result: z.null(),
        error: z.null(),
        skipReason: z.enum(["previous_run_awaiting_input"]),
      }).strict(),
      z.object({
        ...CommonRun,
        state: z.literal("expired"),
        startedAt: z.number().int().nonnegative().nullable(),
        completedAt: z.number().int().nonnegative(),
        result: z.null(),
        error: z.null(),
        stopReason: z.enum(["cancelled", "expired", "blocker_lost"]),
      }).strict(),
    ])
    .superRefine((run, ctx) => {
      if (run.state === "failed" && !run.error && !run.stopReason) {
        ctx.addIssue({ code: "custom", path: ["error"], message: "failed requires error or stopReason" })
      }
    })
    .meta({ ref: "AutomationRun" })
  export type Run = z.infer<typeof Run>

  export const ListResponse = z.object({ items: z.array(Definition) }).meta({ ref: "AutomationListResponse" })
  export const RunsResponse = z
    .object({ items: z.array(Run), nextCursor: RunID.nullable() })
    .meta({ ref: "AutomationRunsResponse" })

  export const Event = {
    DefinitionUpdated: BusEvent.define("automation.definition.updated", Definition),
    DefinitionDeleted: BusEvent.define("automation.definition.deleted", Tombstone),
    RunUpdated: BusEvent.define("automation.run.updated", Run),
  }

  type State = {
    definitions: Map<string, Definition>
    runs: Map<string, Run[]>
  }
  const state = Instance.state<State>(() => ({ definitions: new Map(), runs: new Map() }))

  const COMMON_CREATE_FIELDS = new Set([
    "kind",
    "title",
    "prompt",
    "context",
    "where",
    "timezone",
    "sourceSessionID",
    "automationSessionID",
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
    "sourceSessionID",
    "automationSessionID",
    "fireAt",
    "rhythm",
    "stop",
  ])

  function addDetail(details: ValidationErrorDetail[], field: string, message: string) {
    details.push({ field, message })
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

  function isValidCronInteger(input: string, min: number, max: number) {
    if (!/^\d+$/.test(input)) return false
    const value = Number(input)
    return value >= min && value <= max
  }

  function isValidCronField(input: string, min: number, max: number) {
    if (!input) return false
    return input.split(",").every((item) => {
      const [base, step, extra] = item.split("/")
      if (extra !== undefined) return false
      if (step !== undefined && !isValidCronInteger(step, 1, max)) return false
      if (base === "*") return true
      const range = base.split("-")
      if (range.length === 2) {
        const [start, end] = range
        if (!isValidCronInteger(start, min, max) || !isValidCronInteger(end, min, max)) return false
        return Number(start) <= Number(end)
      }
      if (range.length !== 1) return false
      return isValidCronInteger(base, min, max)
    })
  }

  export function isValidCronExpression(expression: string) {
    const fields = expression.trim().split(/\s+/)
    if (fields.length !== 5) return false
    return (
      isValidCronField(fields[0], 0, 59) &&
      isValidCronField(fields[1], 0, 23) &&
      isValidCronField(fields[2], 1, 31) &&
      isValidCronField(fields[3], 1, 12) &&
      isValidCronField(fields[4], 0, 7)
    )
  }

  function validateScheduleFields(input: CreateInput | Definition) {
    const details: ValidationErrorDetail[] = []
    if (!isValidTimezone(input.timezone)) addDetail(details, "timezone", "invalid_timezone")
    if (input.kind === "recurring" && input.rhythm.kind === "cron" && !isValidCronExpression(input.rhythm.expression)) {
      addDetail(details, "rhythm.expression", "invalid_cron_expression")
    }
    return details
  }

  export function validateCreateInput(input: CreateInput | Definition, projectID = Instance.project.id) {
    const details: ValidationErrorDetail[] = []
    const isDefinition = Object.hasOwn(input, "id")
    if (!isDefinition) {
      if (input.kind === "oneshot") {
        if (Object.hasOwn(input, "rhythm")) addDetail(details, "rhythm", "unsupported_for_oneshot_automation")
        if (Object.hasOwn(input, "stop")) addDetail(details, "stop", "unsupported_for_oneshot_automation")
        rejectUnknownFields(input, ONESHOT_CREATE_FIELDS, details)
      } else {
        if (Object.hasOwn(input, "fireAt")) addDetail(details, "fireAt", "unsupported_for_recurring_automation")
        rejectUnknownFields(input, RECURRING_CREATE_FIELDS, details)
      }
    }
    if (input.where.projectID !== projectID) {
      addDetail(details, "where.projectID", "Automation must target the current project.")
    }
    if (input.where.worktree) addDetail(details, "where.worktree", "unsupported_where_worktree")
    details.push(...validateScheduleFields(input))
    return details
  }

  export function validateUpdateInput(previous: Definition, patch: UpdateInput) {
    const details: ValidationErrorDetail[] = []
    if (previous.kind === "recurring" && Object.hasOwn(patch, "fireAt")) {
      addDetail(details, "fireAt", "unsupported_for_recurring_automation")
    }
    if (previous.kind === "oneshot") {
      for (const field of ["rhythm", "stop"] as const) {
        if (Object.hasOwn(patch, field)) addDetail(details, field, "unsupported_for_oneshot_automation")
      }
    }
    rejectUnknownFields(patch, UPDATE_FIELDS, details)
    if (patch.timezone !== undefined && !isValidTimezone(patch.timezone)) {
      addDetail(details, "timezone", "invalid_timezone")
    }
    if (patch.rhythm?.kind === "cron" && !isValidCronExpression(patch.rhythm.expression)) {
      addDetail(details, "rhythm.expression", "invalid_cron_expression")
    }
    return details
  }

  export function create(input: CreateInput, options?: { now?: number }): Definition {
    const details = validateCreateInput(input)
    if (details.length) throw new ValidationError(details)
    const now = options?.now ?? Date.now()
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
      ...(input.sourceSessionID ? { sourceSessionID: input.sourceSessionID } : {}),
      ...(input.automationSessionID ? { automationSessionID: input.automationSessionID } : {}),
    }
    const definition: Definition =
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
    state().definitions.set(definition.id, definition)
    return definition
  }

  export function list(): Definition[] {
    return [...state().definitions.values()].sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))
  }

  export function get(id: string): Definition {
    const definition = state().definitions.get(id)
    if (!definition) throw new NotFoundError({ message: `Automation not found: ${id}` })
    return definition
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
    return Object.entries(patch).some(([field, value]) => !isSameValue(previous[field as keyof Definition], value))
  }

  export function update(id: string, patch: UpdateInput, options?: { now?: number }): Definition {
    const previous = get(id)
    const updateDetails = validateUpdateInput(previous, patch)
    if (updateDetails.length) throw new ValidationError(updateDetails)
    if (!hasChanges(previous, patch)) return previous
    const next = Definition.parse({
      ...previous,
      ...patch,
      revision: previous.revision + 1,
      updatedAt: options?.now ?? Date.now(),
    })
    const details = validateCreateInput(next)
    if (details.length) throw new ValidationError(details)
    state().definitions.set(id, next)
    return next
  }

  export function remove(id: string): Tombstone {
    const previous = get(id)
    state().definitions.delete(id)
    state().runs.delete(id)
    return { id: previous.id, deleted: true, revision: previous.revision + 1 }
  }

  export function runNow(id: string, options?: { now?: number }): Run {
    const definition = get(id)
    const current = state().runs.get(id) ?? []
    const run = Run.parse({
      id: AutomationID.Run.ascending(),
      automationID: id,
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
    state().runs.set(id, [run, ...current])
    return run
  }

  export function runs(input: { automationID: string; limit?: number; cursor?: string }) {
    get(input.automationID)
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100)
    const all = state().runs.get(input.automationID) ?? []
    const cursorIndex = input.cursor ? all.findIndex((run) => run.id === input.cursor) : -1
    const start = input.cursor ? (cursorIndex === -1 ? all.length : cursorIndex + 1) : 0
    const items = all.slice(start, start + limit)
    return { items, nextCursor: start + limit < all.length ? items.at(-1)?.id ?? null : null }
  }

  export const publishDefinitionUpdated = (definition: Definition) => Bus.publish(Event.DefinitionUpdated, definition)
  export const publishDefinitionDeleted = (tombstone: Tombstone) => Bus.publish(Event.DefinitionDeleted, tombstone)
  export const publishRunUpdated = (run: Run) => Bus.publish(Event.RunUpdated, run)
}

export class ValidationError extends Error {
  constructor(readonly details: { field: string; message: string }[]) {
    super("Invalid automation")
    this.name = "AutomationValidationError"
  }
}
