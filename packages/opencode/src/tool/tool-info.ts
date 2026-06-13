import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import * as EffectZod from "@/util/effect-zod"
import { Parameters as EnterWorktreeParameters } from "./enter-worktree"
import EnterWorktreeDescription from "./enter-worktree.txt"
import { Parameters as ExitWorktreeParameters } from "./exit-worktree"
import ExitWorktreeDescription from "./exit-worktree.txt"
import { Parameters as LspParameters } from "./lsp"
import LspDescription from "./lsp.txt"
import { Parameters as BrowserNavigateParameters } from "./browser-navigate"
import BrowserNavigateDescription from "./browser-navigate.txt"
import { Parameters as BrowserSnapshotParameters } from "./browser-snapshot"
import BrowserSnapshotDescription from "./browser-snapshot.txt"
import { Parameters as BrowserClickParameters } from "./browser-click"
import BrowserClickDescription from "./browser-click.txt"
import { Parameters as BrowserTypeParameters } from "./browser-type"
import BrowserTypeDescription from "./browser-type.txt"
import { Parameters as BrowserWaitParameters } from "./browser-wait"
import BrowserWaitDescription from "./browser-wait.txt"
import { Parameters as BrowserScreenshotParameters } from "./browser-screenshot"
import BrowserScreenshotDescription from "./browser-screenshot.txt"
import { Parameters as BrowserExtractParameters } from "./browser-extract"
import BrowserExtractDescription from "./browser-extract.txt"
import { Parameters as OpenCliSearchParameters } from "./opencli-search"
import OpenCliSearchDescription from "./opencli-search.txt"
import { Parameters as OpenCliRunParameters } from "./opencli-run"
import OpenCliRunDescription from "./opencli-run.txt"
import { ProviderTransform } from "../provider/transform"
import type { Provider } from "../provider/provider"
import type { MessageV2 } from "../session/message-v2"

export const TOOL_INFO_ID = "tool_info"

type DeferredEntry = {
  id: string
  card: string
  description: string
  parameters: Tool.Def["parameters"]
  /** Group activation: tool_info(name=<group>) loads and activates every member at once. */
  group?: string
}

// Single source of truth for deferred tools. id + card + description + parameters
// all live here, so adding a new deferred tool is a one-entry change rather than
// a coordinated edit across DEFERRED_TOOL_IDS, DEFERRED_CARDS, and a registry lookup.
// Cards are one-line summaries shown in tool_info's description (one-line budget
// instead of the full .txt). Grouped entries collapse into one card and activate
// together — the model never loads browser_click alone.
const DEFERRED: DeferredEntry[] = [
  {
    id: "enter-worktree",
    card: "Switch the session into an isolated git worktree to work on a branch in parallel without disturbing the main checkout. Use when a task needs its own branch/worktree.",
    description: EnterWorktreeDescription,
    parameters: EnterWorktreeParameters as unknown as Tool.Def["parameters"],
  },
  {
    id: "exit-worktree",
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
  {
    id: "browser_navigate",
    card: "Open a URL in the embedded browser tab.",
    description: BrowserNavigateDescription,
    parameters: BrowserNavigateParameters as unknown as Tool.Def["parameters"],
    group: "browser",
  },
  {
    id: "browser_snapshot",
    card: "Read the page as a numbered element tree (observe before acting).",
    description: BrowserSnapshotDescription,
    parameters: BrowserSnapshotParameters as unknown as Tool.Def["parameters"],
    group: "browser",
  },
  {
    id: "browser_click",
    card: "Click an element by snapshot ref or CSS selector.",
    description: BrowserClickDescription,
    parameters: BrowserClickParameters as unknown as Tool.Def["parameters"],
    group: "browser",
  },
  {
    id: "browser_type",
    card: "Fill text into an input, with optional Enter to submit.",
    description: BrowserTypeDescription,
    parameters: BrowserTypeParameters as unknown as Tool.Def["parameters"],
    group: "browser",
  },
  {
    id: "browser_wait",
    card: "Wait for text, a selector, or a fixed pause.",
    description: BrowserWaitDescription,
    parameters: BrowserWaitParameters as unknown as Tool.Def["parameters"],
    group: "browser",
  },
  {
    id: "browser_screenshot",
    card: "Capture the page as a PNG image.",
    description: BrowserScreenshotDescription,
    parameters: BrowserScreenshotParameters as unknown as Tool.Def["parameters"],
    group: "browser",
  },
  {
    id: "browser_extract",
    card: "Extract page content as markdown.",
    description: BrowserExtractDescription,
    parameters: BrowserExtractParameters as unknown as Tool.Def["parameters"],
    group: "browser",
  },
  {
    id: "opencli_search",
    card: "Search bundled OpenCLI site adapters by site, task, domain, or command name.",
    description: OpenCliSearchDescription,
    parameters: OpenCliSearchParameters as unknown as Tool.Def["parameters"],
    group: "opencli",
  },
  {
    id: "opencli_run",
    card: "Run one bundled OpenCLI site adapter command returned by opencli_search.",
    description: OpenCliRunDescription,
    parameters: OpenCliRunParameters as unknown as Tool.Def["parameters"],
    group: "opencli",
  },
] as const

// One card per group in tool_info's listing; the member cards appear in the
// group's tool_info output instead.
const GROUP_CARDS: Record<string, string> = {
  browser:
    "Drive the user-visible embedded browser: navigate, snapshot (numbered element refs), click, type, wait, screenshot, extract page content as markdown. Activates as one set — use for general browsing, visual checks, and any site without a bundled adapter; for a specific site, check the opencli group first.",
  opencli:
    "Find and use bundled OpenCLI site adapters for a specific site or site-specific workflow — prefer these over the browser tools when one matches. Start with opencli_search, then run the selected command with opencli_run.",
}

const BY_ID: Record<string, DeferredEntry> = Object.fromEntries(DEFERRED.map((d) => [d.id, d]))

export const DEFERRED_TOOL_IDS: ReadonlySet<string> = new Set(DEFERRED.map((d) => d.id))
export const DEFERRED_GROUP_IDS: ReadonlySet<string> = new Set(DEFERRED.flatMap((d) => (d.group ? [d.group] : [])))
export const DEFERRED_CARDS: Record<string, string> = Object.fromEntries(DEFERRED.map((d) => [d.id, d.card]))

export function deferredGroupMembers(group: string): string[] {
  return DEFERRED.filter((d) => d.group === group).map((d) => d.id)
}

const PREFACE = [
  "Load a deferred tool's full description and parameter schema on demand, then activate it so you can call it.",
  "",
  "Some low-frequency tools are not shown in full up front, to save context. They appear as one-line cards below.",
  "When a task needs one of them, call tool_info with the tool's name. You receive its full description and exact",
  "parameters, and the tool becomes callable on your NEXT step (not the same step). Then call the tool directly.",
  "Some entries are groups (one card, several tools): loading the group activates every tool in it at once.",
].join("\n")

export const Parameters = Schema.Struct({
  name: Schema.String.annotate({
    description:
      "Name of the deferred tool or tool group to load (one of the names listed in this tool's description).",
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
// A group activation (tool_info(name="browser")) expands to every member id, so the
// expansion survives compaction and restart exactly like single-tool activations.
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
    if (typeof name !== "string") continue
    const target = canonicalActivationTarget(name)
    if (!target) continue
    if (target.kind === "group") {
      for (const member of deferredGroupMembers(target.id)) activated.add(member)
    } else {
      activated.add(target.id)
    }
  }
  return activated
}

// Reports the deferred ids (or group ids) newly activated on a SINGLE assistant turn —
// the session's newest NON-SUMMARY assistant (MessageV2.lastNonSummaryAssistant). Used to
// inject the one-shot activation <system-reminder> on exactly the step after a tool_info
// call. It keys on completed tool_info parts' metadata.activated, so once the model takes
// any real (non-tool_info) turn the map is empty and the reminder stops — and a compaction
// summary inserted in between can't suppress it, because summaries are excluded at the
// source. The value is the availability-filtered member list the activation
// rendered (groups only), so the reminder names the same tools.
export function deriveNewlyActivated(
  lastRealAssistant: MessageV2.WithParts | undefined,
): Map<string, string[] | undefined> {
  const newly = new Map<string, string[] | undefined>()
  if (!lastRealAssistant) return newly
  for (const part of lastRealAssistant.parts) {
    if (part.type !== "tool" || part.tool !== TOOL_INFO_ID) continue
    if (part.state.status !== "completed") continue
    const meta = part.state.metadata as { activated?: unknown; members?: unknown } | undefined
    const activated = meta?.activated
    if (typeof activated !== "string") continue
    if (!DEFERRED_TOOL_IDS.has(activated) && !DEFERRED_GROUP_IDS.has(activated)) continue
    const members = Array.isArray(meta?.members)
      ? meta.members.filter((m): m is string => typeof m === "string")
      : undefined
    newly.set(activated, members)
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

// What a tool_info(name=X) call resolves to: a standalone tool, a group (by group
// name OR any member name — a member name still activates its whole group, so the
// "activate as one set" contract holds no matter which name the model echoes), or
// nothing.
export function canonicalActivationTarget(rawName: string): { kind: "tool" | "group"; id: string } | undefined {
  // Group ids follow the same lowercase convention canonicalDeferredId assumes
  // for tool ids, so one lowercased lookup covers the canonical spelling too.
  const lower = rawName.toLowerCase()
  if (DEFERRED_GROUP_IDS.has(lower)) return { kind: "group", id: lower }
  const tool = canonicalDeferredId(rawName)
  if (!tool) return undefined
  const group = BY_ID[tool]?.group
  return group ? { kind: "group", id: group } : { kind: "tool", id: tool }
}

// Repair-time hint when the model directly calls a deferred tool without first loading
// it via tool_info. Canonicalises the name so a CamelCase echo like "Enter-Worktree"
// isn't suggested back as an invalid tool_info argument. Grouped tools route to their
// group name — the activation unit — never to the member id. `isAvailable` (optional)
// gates on per-agent/session availability: a disabled or permission-denied deferred tool
// can't be activated via tool_info either, so we fall back to a plain invalid-tool error
// rather than routing the model to a path that will just fail again.
export function buildDeferredHint(rawToolName: string, isAvailable?: (id: string) => boolean): string {
  const target = canonicalActivationTarget(rawToolName)
  if (!target) return ""
  if (target.kind === "group") {
    const members = deferredGroupMembers(target.id)
    const callable = isAvailable ? members.filter(isAvailable) : members
    if (callable.length === 0) return ""
    const echoed = canonicalDeferredId(rawToolName)
    // The model named a specific member: activation only helps if THAT member
    // will be exposed afterwards. A disabled member must get the plain
    // invalid-tool error, not a hint promising a tool the registry filters out.
    if (echoed && !callable.includes(echoed)) return ""
    const member = echoed ?? callable[0]
    return ` "${member}" is part of the deferred "${target.id}" tool group: call tool_info with name="${target.id}" to load and activate the whole group, then call ${member} on your next step.`
  }
  if (isAvailable && !isAvailable(target.id)) return ""
  return ` "${target.id}" is a deferred tool: call tool_info with name="${target.id}" to load and activate it, then call it on your next step.`
}

// Tool-specific anti-fallback hint. Empty when the tool has no obvious bash equivalent.
const ANTI_FALLBACK: Record<string, string> = {
  "enter-worktree": " Do not use `bash git worktree` as a substitute.",
}

// One-shot system-reminder for the step after a tool_info activation. Anchored on
// <system-reminder> because models attend to system signals more reliably than to
// tool self-descriptions. For a group, list the members so the model calls a real
// tool (there is no callable tool named after the group) — starting from the
// availability-filtered list the activation recorded, then re-filtering through
// `isAvailable` (the CURRENT step's availability): the recorded list is a snapshot,
// and a session resumed under different permissions or a different client must not
// be promised a tool the registry won't expose now. Returns "" when nothing the
// reminder would announce is actually in the tool list — callers skip injection.
export function buildActivationReminder(
  name: string,
  activatedMembers?: string[],
  isAvailable?: (id: string) => boolean,
): string {
  if (DEFERRED_GROUP_IDS.has(name)) {
    const recorded = activatedMembers?.length ? activatedMembers : deferredGroupMembers(name)
    const current = isAvailable ? recorded.filter(isAvailable) : recorded
    if (current.length === 0) return ""
    const members = current.join(", ")
    return [
      "<system-reminder>",
      `Deferred tool group activated: the \`${name}\` tools (${members}) are now in your tool list for this step. ` +
        `Call them directly (there is no tool named \`${name}\`). ` +
        `Do not call \`tool_info\` again for this group.`,
      "</system-reminder>",
    ].join("\n")
  }
  if (isAvailable && !isAvailable(name)) return ""
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
// activated and permitted for this agent/session/client. Grouped ids collapse
// into one card under the group name.
export function buildCardList(available: string[]): string {
  const groups: string[] = []
  const standalone: string[] = []
  for (const id of available) {
    const group = BY_ID[id]?.group
    if (group) {
      if (!groups.includes(group)) groups.push(group)
    } else {
      standalone.push(id)
    }
  }
  if (groups.length === 0 && standalone.length === 0) return "No deferred tools are currently available to load."
  return [
    "Deferred tools available to load (call tool_info with the name, then call the tool on your next step):",
    "",
    ...standalone.map((id) => `- **${id}**: ${DEFERRED_CARDS[id] ?? ""}`),
    ...groups.map((group) => `- **${group}** (tool group): ${GROUP_CARDS[group] ?? ""}`),
  ].join("\n")
}

function renderToolBlock(
  entry: DeferredEntry,
  processed: { description: string; parameters: Tool.Def["parameters"] },
  model: Provider.Model | undefined,
): string {
  const raw = EffectZod.toJsonSchema(processed.parameters)
  const schema = model ? ProviderTransform.schema(model, raw) : raw
  return [
    `<tool_info name="${entry.id}">`,
    processed.description.trim(),
    "",
    "Parameters (JSON Schema):",
    "```json",
    JSON.stringify(schema, null, 2),
    "```",
    "</tool_info>",
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
            // Target ids are canonical by construction, so every downstream string and
            // the activation metadata use the canonical form.
            const target = canonicalActivationTarget(params.name)
            if (!target) {
              const names = [...DEFERRED_GROUP_IDS, ...DEFERRED.filter((d) => !d.group).map((d) => d.id)].join(", ")
              return yield* Effect.fail(
                new Error(`Unknown deferred tool "${params.name}". Available: ${names || "none"}`),
              )
            }
            const isAvailable = ctx.extra?.["deferredAvailable"] as ((id: string) => boolean) | undefined
            // Render only the members the registry will actually expose next
            // step (it filters per member): announcing a disabled member would
            // point the model at a tool that never appears in its list.
            const allEntries =
              target.kind === "group" ? deferredGroupMembers(target.id).map((id) => BY_ID[id]) : [BY_ID[target.id]]
            const entries = isAvailable ? allEntries.filter((entry) => isAvailable(entry.id)) : allEntries
            if (entries.length === 0) {
              return yield* Effect.fail(new Error(`Deferred tool "${target.id}" is not available in this context.`))
            }
            const model = ctx.extra?.["model"] as Provider.Model | undefined
            const blocks: string[] = []
            for (const entry of entries) {
              const processed = { description: entry.description, parameters: entry.parameters }
              yield* applyPluginDefinition(entry.id, processed)
              blocks.push(renderToolBlock(entry, processed, model))
            }
            const callable =
              target.kind === "group"
                ? `The ${target.id} tools (${entries.map((entry) => entry.id).join(", ")}) are now in your tool list. Call them directly (there is no tool named "${target.id}"). Do not call tool_info again for this group.`
                : `${target.id} is now in your tool list. Call ${target.id} directly. Do not call tool_info again for this tool.`
            return {
              title: `Loaded ${target.kind === "group" ? "tool group" : "tool"}: ${target.id}`,
              output: [...blocks, "", callable].join("\n"),
              // truncated:false opts this tool out of output truncation (see tool.ts
              // wrap): tool_info exists to hand the model a *complete* schema, so a
              // large deferred tool's parameters must never be clipped mid-load.
              // For a group, `members` records the members actually rendered
              // (availability-filtered) so the activation reminder lists the
              // same set instead of the full roster.
              metadata: {
                activated: target.id,
                ...(target.kind === "group" ? { members: entries.map((entry) => entry.id) } : {}),
                truncated: false,
              },
            }
          }),
      }
    }),
  )
