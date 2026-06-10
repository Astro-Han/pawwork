import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import * as EffectZod from "@/util/effect-zod"
import { Parameters as EnterWorktreeParameters } from "./enter-worktree"
import EnterWorktreeDescription from "./enter-worktree.txt"
import { Parameters as ExitWorktreeParameters } from "./exit-worktree"
import ExitWorktreeDescription from "./exit-worktree.txt"
import { Parameters as LspParameters } from "./lsp"
import LspDescription from "./lsp.txt"
import { ProviderTransform } from "../provider/transform"
import type { Provider } from "../provider/provider"
import type { MessageV2 } from "../session/message-v2"

export const TOOL_INFO_ID = "tool_info"

// Single source of truth for deferred tools. id + card + description + parameters
// all live here, so adding a new deferred tool is a one-entry change rather than
// a coordinated edit across DEFERRED_TOOL_IDS, DEFERRED_CARDS, and a registry lookup.
// Cards are one-line summaries shown in tool_info's description (one-line budget
// instead of the full .txt).
const DEFERRED = [
  {
    id: "enter-worktree" as const,
    card: "Switch the session into an isolated git worktree to work on a branch in parallel without disturbing the main checkout. Use when a task needs its own branch/worktree.",
    description: EnterWorktreeDescription,
    parameters: EnterWorktreeParameters as unknown as Tool.Def["parameters"],
  },
  {
    id: "exit-worktree" as const,
    card: "Leave the current worktree and return the session to the project root.",
    description: ExitWorktreeDescription,
    parameters: ExitWorktreeParameters as unknown as Tool.Def["parameters"],
  },
  {
    id: "lsp" as const,
    card: "Use language-server code intelligence for definitions, references, hover, and symbol navigation.",
    description: LspDescription,
    parameters: LspParameters as unknown as Tool.Def["parameters"],
  },
] as const

const BY_ID: Record<string, (typeof DEFERRED)[number]> = Object.fromEntries(DEFERRED.map((d) => [d.id, d]))

export const DEFERRED_TOOL_IDS: ReadonlySet<string> = new Set(DEFERRED.map((d) => d.id))
export const DEFERRED_CARDS: Record<string, string> = Object.fromEntries(DEFERRED.map((d) => [d.id, d.card]))

const PREFACE = [
  "Load a deferred tool's full description and parameter schema on demand, then activate it so you can call it.",
  "",
  "Some low-frequency tools are not shown in full up front, to save context. They appear as one-line cards below.",
  "When a task needs one of them, call tool_info with the tool's name. You receive its full description and exact",
  "parameters, and the tool becomes callable on your NEXT step (not the same step). Then call the tool directly.",
].join("\n")

export const Parameters = Schema.Struct({
  name: Schema.String.annotate({
    description: "Name of the deferred tool to load (one of the names listed in this tool's description).",
  }),
})

// Activation is derived from durable conversation history, not a side state: a completed
// tool_info(name=X) call means X is activated for the rest of that history. It must be
// derived from the COMPLETE history — an activation older than the compaction tail still
// counts — so the prompt loop feeds deriveActivatedToolsFromParts the session's tool_info
// parts straight from storage (MessageV2.toolInfoParts), NOT the compaction-filtered
// model-facing view (which drops messages before the retained tail and would let a
// deferred tool silently re-lock mid-session). This overload derives the same set from
// already-hydrated messages and is used by tests.
export function deriveActivatedTools(messages: MessageV2.WithParts[]): Set<string> {
  const parts: MessageV2.Part[] = []
  for (const message of messages) parts.push(...message.parts)
  return deriveActivatedToolsFromParts(parts)
}

// Core derivation over raw tool parts — the storage-fed path the prompt loop runs.
export function deriveActivatedToolsFromParts(parts: MessageV2.Part[]): Set<string> {
  const activated = new Set<string>()
  for (const part of parts) {
    if (part.type !== "tool" || part.tool !== TOOL_INFO_ID) continue
    if (part.state.status !== "completed") continue
    // The recorded input keeps the model's raw casing (e.g. "Enter-Worktree"), so
    // canonicalise here exactly like tool_info's own lookup does — otherwise a CamelCase
    // echo would activate metadata-side yet never appear in the next step's tool list,
    // leaving the model pointed at a tool that isn't exposed.
    const name = part.state.input?.["name"]
    const canonical = typeof name === "string" ? canonicalDeferredId(name) : undefined
    if (canonical) activated.add(canonical)
  }
  return activated
}

// Reports the deferred ids newly activated on a SINGLE assistant turn — the session's
// newest NON-SUMMARY assistant (MessageV2.lastNonSummaryAssistant). Used to inject the
// one-shot activation <system-reminder> on exactly the step after a tool_info call. It
// keys on completed tool_info parts' metadata.activated, so once the model takes any real
// (non-tool_info) turn the set is empty and the reminder stops — and a compaction summary
// inserted in between can't suppress it, because summaries are excluded at the source.
export function deriveNewlyActivated(lastRealAssistant: MessageV2.WithParts | undefined): Set<string> {
  const newly = new Set<string>()
  if (!lastRealAssistant) return newly
  for (const part of lastRealAssistant.parts) {
    if (part.type !== "tool" || part.tool !== TOOL_INFO_ID) continue
    if (part.state.status !== "completed") continue
    const activated = (part.state.metadata as { activated?: unknown } | undefined)?.activated
    if (typeof activated === "string" && DEFERRED_TOOL_IDS.has(activated)) newly.add(activated)
  }
  return newly
}

// Maps a possibly mis-cased model echo (e.g. "Enter-Worktree") to the canonical
// kebab-case deferred id, or undefined if the name isn't a deferred tool. Single
// source for the lenient matching used by both the repair hint and tool_info's
// own lookup, so the two never disagree on what counts as a deferred tool.
export function canonicalDeferredId(rawName: string): string | undefined {
  if (DEFERRED_TOOL_IDS.has(rawName)) return rawName
  const lower = rawName.toLowerCase()
  return DEFERRED_TOOL_IDS.has(lower) ? lower : undefined
}

// Repair-time hint when the model directly calls a deferred tool without first loading
// it via tool_info. Canonicalises the name so a CamelCase echo like "Enter-Worktree"
// isn't suggested back as an invalid tool_info argument. `isAvailable` (optional) gates
// on per-agent/session availability: a disabled or permission-denied deferred tool can't
// be activated via tool_info either, so we fall back to a plain invalid-tool error rather
// than routing the model to a path that will just fail again.
export function buildDeferredHint(rawToolName: string, isAvailable?: (id: string) => boolean): string {
  const canonical = canonicalDeferredId(rawToolName)
  if (!canonical) return ""
  if (isAvailable && !isAvailable(canonical)) return ""
  return ` "${canonical}" is a deferred tool: call tool_info with name="${canonical}" to load and activate it, then call it on your next step.`
}

// Tool-specific anti-fallback hint. Empty when the tool has no obvious bash equivalent.
const ANTI_FALLBACK: Record<string, string> = {
  "enter-worktree": " Do not use `bash git worktree` as a substitute.",
}

// One-shot system-reminder for the step after a tool_info activation. Anchored on
// <system-reminder> because models attend to system signals more reliably than to
// tool self-descriptions.
export function buildActivationReminder(name: string): string {
  return [
    "<system-reminder>",
    `Deferred tool activated: \`${name}\` is now in your tool list for this step. ` +
      `Call \`${name}\` directly to continue. ` +
      `Do not call \`tool_info\` again for this tool.${ANTI_FALLBACK[name] ?? ""}`,
    "</system-reminder>",
  ].join("\n")
}

// Dynamic card list appended to tool_info's static preface each turn (the
// registry joins it after PREFACE). `available` are deferred ids not yet
// activated and permitted for this agent/session.
export function buildCardList(available: string[]): string {
  if (available.length === 0) return "No deferred tools are currently available to load."
  return [
    "Deferred tools available to load (call tool_info with the name, then call the tool on your next step):",
    "",
    ...available.map((id) => `- **${id}**: ${DEFERRED_CARDS[id] ?? ""}`),
  ].join("\n")
}

// tool_info as a first-class Tool.define so it gets the same wrapping (truncation,
// validation, spans, error formatting) as every other builtin. applyPluginDefinition
// is the closure the registry passes in: it runs the same plugin.trigger pipeline
// that registry.tools() uses, so what the model reads here matches what the next
// step's tool list will hand it. Kept as a closure (rather than yield* Plugin.Service)
// so this Tool.define stays Plugin-free in its R, which lets the registry yield it
// at the outer make scope alongside the other Tool.define exports.
export const ToolInfoTool = (
  applyPluginDefinition: (
    toolID: string,
    output: { description: string; parameters: Tool.Def["parameters"] },
  ) => Effect.Effect<void>,
) =>
  Tool.define(
    TOOL_INFO_ID,
    Effect.gen(function* () {
      return {
        description: PREFACE,
        parameters: Parameters,
        execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
          Effect.gen(function* () {
            // Canonicalise first so a CamelCase echo (e.g. "Enter-Worktree") resolves
            // to the real id instead of burning a turn on an "unknown tool" error.
            // target.id is canonical by construction, so every downstream string and
            // the activation metadata use the canonical form.
            const target = BY_ID[canonicalDeferredId(params.name) ?? ""]
            if (!target) {
              const names = [...DEFERRED_TOOL_IDS].join(", ")
              return yield* Effect.fail(
                new Error(`Unknown deferred tool "${params.name}". Available: ${names || "none"}`),
              )
            }
            const isAvailable = ctx.extra?.["deferredAvailable"] as ((id: string) => boolean) | undefined
            if (isAvailable && !isAvailable(target.id)) {
              return yield* Effect.fail(new Error(`Deferred tool "${target.id}" is not available in this context.`))
            }
            const processed = { description: target.description, parameters: target.parameters }
            yield* applyPluginDefinition(target.id, processed)
            const model = ctx.extra?.["model"] as Provider.Model | undefined
            const raw = EffectZod.toJsonSchema(processed.parameters)
            const schema = model ? ProviderTransform.schema(model, raw) : raw
            return {
              title: `Loaded tool: ${target.id}`,
              output: [
                `<tool_info name="${target.id}">`,
                processed.description.trim(),
                "",
                "Parameters (JSON Schema):",
                "```json",
                JSON.stringify(schema, null, 2),
                "```",
                "",
                `${target.id} is now in your tool list. Call ${target.id} directly. Do not call tool_info again for this tool.`,
                "</tool_info>",
              ].join("\n"),
              // truncated:false opts this tool out of output truncation (see tool.ts
              // wrap): tool_info exists to hand the model a *complete* schema, so a
              // large deferred tool's parameters must never be clipped mid-load.
              metadata: { activated: target.id, truncated: false },
            }
          }),
      }
    }),
  )
