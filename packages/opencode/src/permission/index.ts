import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { ProjectID } from "@/project/schema"
import { Instance } from "@/project/instance"
import { MessageID, SessionID } from "@/session/schema"
import { PermissionTable } from "@/session/session.sql"
import { Database, NotFoundError, eq } from "@/storage/db"
import { Log } from "@opencode-ai/core/util/log"
import { Wildcard } from "@/util/wildcard"
import { Deferred, Effect, Layer, Schema, Context } from "effect"
import os from "os"
import z from "zod"
import { fromDeniedRule, isPermanentDeleteRule, render, type DenialDiagnostic } from "./diagnostic"
import { evaluate as evalRule } from "./evaluate"
import { PermissionID } from "./schema"

export namespace Permission {
  const log = Log.create({ service: "permission" })

  export const Action = z.enum(["allow", "deny", "ask"]).meta({
    ref: "PermissionAction",
  })
  export type Action = z.infer<typeof Action>

  export const Rule = z
    .object({
      permission: z.string(),
      pattern: z.string(),
      action: Action,
    })
    .meta({
      ref: "PermissionRule",
    })
  export type Rule = z.infer<typeof Rule>

  export const Ruleset = Rule.array().meta({
    ref: "PermissionRuleset",
  })
  export type Ruleset = z.infer<typeof Ruleset>

  export const Request = z
    .object({
      id: PermissionID.zod,
      sessionID: SessionID.zod,
      permission: z.string(),
      patterns: z.string().array(),
      metadata: z.record(z.string(), z.any()),
      always: z.string().array(),
      tool: z
        .object({
          messageID: MessageID.zod,
          callID: z.string(),
        })
        .optional(),
    })
    .meta({
      ref: "PermissionRequest",
    })
  export type Request = z.infer<typeof Request>

  export const Reply = z.enum(["once", "always", "reject"])
  export type Reply = z.infer<typeof Reply>

  export const Approval = z.object({
    projectID: ProjectID.zod,
    patterns: z.string().array(),
  })

  export const Event = {
    Asked: BusEvent.define("permission.asked", Request),
    Replied: BusEvent.define(
      "permission.replied",
      z.object({
        sessionID: SessionID.zod,
        requestID: PermissionID.zod,
        reply: Reply,
      }),
    ),
  }

  export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("PermissionRejectedError", {}) {
    override get message() {
      return "The user rejected permission to use this specific tool call."
    }
  }

  export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionCorrectedError", {
    feedback: Schema.String,
  }) {
    override get message() {
      return `The user rejected permission to use this specific tool call with the following feedback: ${this.feedback}`
    }
  }

  export class DeniedError extends Schema.TaggedErrorClass<DeniedError>()("PermissionDeniedError", {
    ruleset: Schema.Any,
    diagnostic: Schema.optional(Schema.Any),
  }) {
    override get message() {
      if (this.diagnostic) return render(this.diagnostic as DenialDiagnostic)
      return `The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules ${JSON.stringify(this.ruleset)}`
    }
  }

  export type Error = DeniedError | RejectedError | CorrectedError

  export const AskInput = Request.partial({ id: true }).extend({
    ruleset: Ruleset,
  })

  export const ReplyInput = z.object({
    requestID: PermissionID.zod,
    reply: Reply,
    message: z.string().optional(),
  })

  export type AskOptions = z.infer<typeof AskInput> & {
    onPending?: (request: Request) => Effect.Effect<void>
  }

  export interface Interface {
    readonly ask: (input: AskOptions) => Effect.Effect<void, Error>
    readonly reply: (input: z.infer<typeof ReplyInput>) => Effect.Effect<void>
    readonly clearSession: (
      sessionID: SessionID,
      reason: "session_deleted" | "session_archived" | "dangling_session",
    ) => Effect.Effect<void>
    readonly list: () => Effect.Effect<Request[]>
  }

  interface PendingEntry {
    info: Request
    deferred: Deferred.Deferred<void, RejectedError | CorrectedError>
  }

  interface State {
    pending: Map<PermissionID, PendingEntry>
    approved: Ruleset
    // Tombstone of recently-resolved request IDs. A reply can cascade-resolve
    // sibling pending requests, so a client's own follow-up reply to one of
    // those would otherwise miss `pending` and look unknown. Remembering the ID
    // briefly lets that repeat reply be an idempotent success instead of a
    // misleading 404, while a genuinely unknown ID still surfaces as not-found.
    resolved: Set<PermissionID>
  }

  // Bounded FIFO memory backstop for the tombstone. The cap only needs to keep
  // an entry alive across the gap between a cascade-resolve and the client's own
  // follow-up reply (sub-second), so eviction by insertion order is fine — as
  // long as the cap stays well above the most requests one reply can resolve at
  // once. A single "always"/"reject" cascade resolves at most the pending count
  // of one session; permission asks are human-paced (auto-approved rules never
  // pend), so that count is realistically dozens. This cap sits far above it, so
  // a cascade can never evict its own freshly-resolved siblings and turn their
  // legitimate follow-up reply into a false 404.
  const RESOLVED_TOMBSTONE_LIMIT = 10_000
  function markResolved(resolved: Set<PermissionID>, id: PermissionID) {
    resolved.add(id)
    if (resolved.size > RESOLVED_TOMBSTONE_LIMIT) {
      const oldest = resolved.values().next().value
      if (oldest !== undefined) resolved.delete(oldest)
    }
  }

  export function evaluate(permission: string, pattern: string, ...rulesets: Ruleset[]): Rule {
    log.info("evaluate", { permission, pattern, ruleset: rulesets.flat() })
    return evalRule(permission, pattern, ...rulesets)
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const state = yield* InstanceState.make<State>(
        Effect.fn("Permission.state")(function* (ctx) {
          const row = Database.use((db) =>
            db.select().from(PermissionTable).where(eq(PermissionTable.project_id, ctx.project.id)).get(),
          )
          const state = {
            pending: new Map<PermissionID, PendingEntry>(),
            approved: row?.data ?? [],
            resolved: new Set<PermissionID>(),
          }

          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              for (const item of state.pending.values()) {
                yield* Deferred.fail(item.deferred, new RejectedError())
              }
              state.pending.clear()
            }),
          )

          return state
        }),
      )

      const ask = Effect.fn("Permission.ask")(function* (input: AskOptions) {
        const { approved, pending, resolved } = yield* InstanceState.get(state)
        const { ruleset, onPending, ...request } = input
        let needsAsk = false
        const denied: Array<{ pattern: string; rule: Rule }> = []

        for (const pattern of request.patterns) {
          const rule = evaluate(request.permission, pattern, ruleset, approved)
          log.info("evaluated", { permission: request.permission, pattern, action: rule })
          if (rule.action === "deny") {
            denied.push({ pattern, rule })
            continue
          }
          if (rule.action === "allow") continue
          needsAsk = true
        }

        if (denied.length > 0) {
          const primaryIndex =
            request.permission === "bash" ? denied.findIndex((item) => isPermanentDeleteRule(item.rule)) : -1
          const primary = primaryIndex >= 0 ? denied[primaryIndex] : denied[0]
          const rest = denied.filter((_, index) => index !== (primaryIndex >= 0 ? primaryIndex : 0))
          const diagnostic = primary
            ? fromDeniedRule({
                permission: request.permission,
                blockedCommand: primary.pattern,
                matchedRule: primary.rule,
                additionalBlockedCommands: rest.map((item) => ({
                  blockedCommand: item.pattern,
                  matchedRule: item.rule,
                })),
              })
            : undefined

          return yield* new DeniedError({
            ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
            ...(diagnostic ? { diagnostic } : {}),
          })
        }

        if (!needsAsk) return

        const id = request.id ?? PermissionID.ascending()
        const info: Request = {
          id,
          ...request,
        }
        log.info("asking", { id, permission: info.permission, patterns: info.patterns })

        const deferred = yield* Deferred.make<void, RejectedError | CorrectedError>()
        pending.set(id, { info, deferred })
        if (onPending) yield* onPending(info)
        yield* bus.publish(Event.Asked, info)
        return yield* Effect.ensuring(
          Deferred.await(deferred),
          Effect.sync(() => {
            pending.delete(id)
            markResolved(resolved, id)
          }),
        )
      })

      const reply = Effect.fn("Permission.reply")(function* (input: z.infer<typeof ReplyInput>) {
        const { approved, pending, resolved } = yield* InstanceState.get(state)
        const existing = pending.get(input.requestID)
        if (!existing) {
          // Already handled (most often as a cascade sibling of an earlier
          // reply) -> idempotent success. Genuinely unknown -> surface the
          // route's documented 404 via ErrorMiddleware's NotFoundError mapping.
          if (resolved.has(input.requestID)) return
          throw new NotFoundError({ message: `Permission request not found: ${input.requestID}` })
        }

        pending.delete(input.requestID)
        markResolved(resolved, input.requestID)
        yield* bus.publish(Event.Replied, {
          sessionID: existing.info.sessionID,
          requestID: existing.info.id,
          reply: input.reply,
        })

        if (input.reply === "reject") {
          yield* Deferred.fail(
            existing.deferred,
            input.message ? new CorrectedError({ feedback: input.message }) : new RejectedError(),
          )

          for (const [id, item] of pending.entries()) {
            if (item.info.sessionID !== existing.info.sessionID) continue
            pending.delete(id)
            markResolved(resolved, id)
            yield* bus.publish(Event.Replied, {
              sessionID: item.info.sessionID,
              requestID: item.info.id,
              reply: "reject",
            })
            yield* Deferred.fail(item.deferred, new RejectedError())
          }
          return
        }

        yield* Deferred.succeed(existing.deferred, undefined)
        if (input.reply === "once") return

        for (const pattern of existing.info.always) {
          approved.push({
            permission: existing.info.permission,
            pattern,
            action: "allow",
          })
        }

        for (const [id, item] of pending.entries()) {
          if (item.info.sessionID !== existing.info.sessionID) continue
          const ok = item.info.patterns.every(
            (pattern) => evaluate(item.info.permission, pattern, approved).action === "allow",
          )
          if (!ok) continue
          pending.delete(id)
          markResolved(resolved, id)
          yield* bus.publish(Event.Replied, {
            sessionID: item.info.sessionID,
            requestID: item.info.id,
            reply: "always",
          })
          yield* Deferred.succeed(item.deferred, undefined)
        }
      })

      const clearSession = Effect.fn("Permission.clearSession")(function* (
        sessionID: SessionID,
        _reason: "session_deleted" | "session_archived" | "dangling_session",
      ) {
        const { pending, resolved } = yield* InstanceState.get(state)
        for (const [id, item] of Array.from(pending.entries())) {
          if (item.info.sessionID !== sessionID) continue
          pending.delete(id)
          markResolved(resolved, id)
          yield* bus.publish(Event.Replied, {
            sessionID: item.info.sessionID,
            requestID: item.info.id,
            reply: "reject",
          })
          yield* Deferred.fail(item.deferred, new RejectedError())
        }
      })

      const list = Effect.fn("Permission.list")(function* () {
        const pending = (yield* InstanceState.get(state)).pending
        return Array.from(pending.values(), (item) => item.info)
      })

      return Service.of({ ask, reply, clearSession, list })
    }),
  )

  function expand(pattern: string): string {
    if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
    if (pattern === "~") return os.homedir()
    if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
    if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
    return pattern
  }

  // Map legacy permission keys to their renamed equivalent so existing user configs keep working
  // after the agent rename (#128). The Schema rest record accepts the old key but ToolRegistry now
  // queries the new name, so without this normalization a user-configured `permission.task` rule
  // would silently stop applying.
  const LEGACY_KEY_ALIASES: Record<string, string> = {
    task: "agent", // agent-rename:legacy-render
  }

  export function fromConfig(permission: Config.Permission) {
    // Sort top-level keys so wildcard permissions (`*`, `mcp_*`) come before
    // specific ones. Combined with `findLast` in `disabled()`, this gives the
    // intuitive semantic "specific tool rules override the `*` fallback"
    // regardless of the user's JSON key order — which is now reordered by
    // ConfigPermission.Info's StructWithRest decoder anyway. Sub-pattern
    // order inside a single permission key is preserved.
    const entries = Object.entries(permission).sort(([a], [b]) => {
      const aWildcard = a.includes("*")
      const bWildcard = b.includes("*")
      if (aWildcard !== bWildcard) return aWildcard ? -1 : 1
      return 0
    })
    const ruleset: Ruleset = []
    for (const [rawKey, value] of entries) {
      const key = LEGACY_KEY_ALIASES[rawKey] ?? rawKey
      // If a config sets both the canonical key (`agent`) and its legacy alias
      // (`task`), drop the legacy entry so the canonical rule isn't silently
      // overridden by the alias under last-match-wins precedence.
      if (key !== rawKey && Object.prototype.hasOwnProperty.call(permission, key)) continue
      if (typeof value === "string") {
        ruleset.push({ permission: key, action: value, pattern: "*" })
        continue
      }
      ruleset.push(
        ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
      )
    }
    return ruleset
  }

  export function merge(...rulesets: Ruleset[]): Ruleset {
    return rulesets.flat()
  }

  const EDIT_TOOLS = ["edit", "write", "apply_patch"]

  export function disabled(tools: string[], ruleset: Ruleset): Set<string> {
    const result = new Set<string>()
    for (const tool of tools) {
      // browser_* tools all ask the `browser` permission key, so a configured
      // `permission.browser: deny` disables the whole set (hiding their
      // deferred cards and repair hints, not just denying the eventual ask).
      const permission = EDIT_TOOLS.includes(tool) ? "edit" : tool.startsWith("browser_") ? "browser" : tool
      const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
      if (!rule) continue
      if (rule.pattern === "*" && rule.action === "deny") result.add(tool)
    }
    return result
  }

  export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

  export const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function ask(input: z.infer<typeof AskInput>) {
    return runPromise((s) => s.ask(input))
  }

  export async function reply(input: z.infer<typeof ReplyInput>) {
    return runPromise((s) => s.reply(input))
  }

  export async function list() {
    return runPromise((s) => s.list())
  }
}
