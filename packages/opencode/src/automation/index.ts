import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Identifier } from "@/id/id"
import { Instance } from "@/project/instance"
import { ProjectID } from "@/project/schema"
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
      z.object({ kind: z.literal("oneshot"), ...CommonCreate, fireAt: z.number().int().nonnegative() }),
      z.object({ kind: z.literal("recurring"), ...CommonCreate, rhythm: Rhythm, stop: Stop }),
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
    .object({
      kind: z.enum(["permission", "question"]),
      sessionID: SessionID.zod,
      requestID: z.string().optional(),
      callID: z.string().optional(),
    })
    .meta({ ref: "AutomationRunBlocker" })
  export const Error = z
    .object({
      code: z.enum(["needs_user_input", "execution_failed", "unsupported_where_worktree"]),
      message: z.string(),
    })
    .meta({ ref: "AutomationRunError" })
  export const Run = z
    .object({
      id: RunID,
      automationID: DefinitionID,
      revision: z.number().int().positive(),
      state: z.enum(["scheduled", "running", "awaiting_input", "succeeded", "failed", "skipped", "expired"]),
      blocker: Blocker.optional(),
      triggeredAt: z.number().int().nonnegative(),
      startedAt: z.number().int().nonnegative().nullable(),
      completedAt: z.number().int().nonnegative().nullable(),
      sessionID: SessionID.zod.nullable(),
      result: z.string().nullable(),
      error: Error.nullable(),
      skipReason: z.enum(["previous_run_awaiting_input"]).optional(),
      stopReason: z.enum(["step_cap", "loop_gate", "cancelled", "expired", "blocker_lost"]).optional(),
      cost: z.number().nonnegative().nullable(),
    })
    .superRefine((run, ctx) => {
      if (!run.stopReason) return
      if (["step_cap", "loop_gate"].includes(run.stopReason) && run.state !== "failed") {
        ctx.addIssue({ code: "custom", path: ["state"], message: `${run.stopReason} requires failed state` })
      }
      if (["cancelled", "expired", "blocker_lost"].includes(run.stopReason) && run.state !== "expired") {
        ctx.addIssue({ code: "custom", path: ["state"], message: `${run.stopReason} requires expired state` })
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

  export function validateCreateInput(input: CreateInput | Definition, projectID = Instance.project.id) {
    const details: { field: string; message: string }[] = []
    if (input.where.projectID !== projectID) {
      details.push({ field: "where.projectID", message: "Automation must target the current project." })
    }
    if (input.where.worktree) details.push({ field: "where.worktree", message: "unsupported_where_worktree" })
    return details
  }

  export function validateUpdateInput(previous: Definition, patch: UpdateInput) {
    const details: { field: string; message: string }[] = []
    if (previous.kind === "recurring" && Object.hasOwn(patch, "fireAt")) {
      details.push({ field: "fireAt", message: "unsupported_for_recurring_automation" })
    }
    if (previous.kind === "oneshot") {
      for (const field of ["rhythm", "stop"] as const) {
        if (Object.hasOwn(patch, field)) details.push({ field, message: "unsupported_for_oneshot_automation" })
      }
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

  export function update(id: string, patch: UpdateInput, options?: { now?: number }): Definition {
    const previous = get(id)
    const updateDetails = validateUpdateInput(previous, patch)
    if (updateDetails.length) throw new ValidationError(updateDetails)
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
    get(id)
    const current = state().runs.get(id) ?? []
    const run = Run.parse({
      id: AutomationID.Run.ascending(),
      automationID: id,
      revision: current.length + 1,
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
