import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import * as EffectZod from "@/util/effect-zod"
import { ProviderTransform } from "../provider/transform"
import type { Provider } from "../provider/provider"
import type { MessageV2 } from "../session/message-v2"

export const TOOL_INFO_ID = "tool_info"

// Tools whose full description + parameter schema are withheld from the default
// tool surface and only loaded once the model activates them via tool_info.
// Hardcoded for v1 (issue #1054): both are 0-invocation in historical samples,
// so a discovery miss harms no real user workflow while the mechanism is proven.
export const DEFERRED_TOOL_IDS: ReadonlySet<string> = new Set(["enter-worktree", "exit-worktree"])

// One-line business cards shown in tool_info's description. Deliberately short:
// the whole point is to spend ~one line of budget instead of the full .txt.
export const DEFERRED_CARDS: Record<string, string> = {
  "enter-worktree":
    "Switch the session into an isolated git worktree to work on a branch in parallel without disturbing the main checkout. Use when a task needs its own branch/worktree.",
  "exit-worktree": "Leave the current worktree and return the session to the project root.",
}

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

// Activation is derived from durable conversation history, not a side state: a
// completed tool_info(name=X) call means X is activated for the rest of that
// history. Mirrors how provider-native tool search carries "discovered" state in
// the conversation, and stays consistent across retry/fork/compaction.
export function deriveActivatedTools(messages: MessageV2.WithParts[]): Set<string> {
  const activated = new Set<string>()
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "tool" || part.tool !== TOOL_INFO_ID) continue
      if (part.state.status !== "completed") continue
      const name = part.state.input?.["name"]
      if (typeof name === "string" && DEFERRED_TOOL_IDS.has(name)) activated.add(name)
    }
  }
  return activated
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

export function makeToolInfoTool(input: {
  lookup: (id: string) => { description: string; parameters: Tool.Def["parameters"] } | undefined
}): Tool.Def {
  return {
    id: TOOL_INFO_ID,
    description: PREFACE,
    parameters: Parameters,
    execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
      Effect.gen(function* () {
        const target = input.lookup(params.name)
        if (!target) {
          const available = [...DEFERRED_TOOL_IDS].join(", ")
          throw new Error(`Unknown deferred tool "${params.name}". Available: ${available || "none"}`)
        }
        // Return the SAME provider-transformed schema the real call will use, so
        // the parameters the model reads here match what it must emit later.
        const model = ctx.extra?.["model"] as Provider.Model | undefined
        const raw = EffectZod.toJsonSchema(target.parameters)
        const schema = model ? ProviderTransform.schema(model, raw) : raw
        return {
          title: `Loaded tool: ${params.name}`,
          output: [
            `<tool_info name="${params.name}">`,
            target.description.trim(),
            "",
            "Parameters (JSON Schema):",
            "```json",
            JSON.stringify(schema, null, 2),
            "```",
            "",
            `${params.name} is now available. Call it directly on your next step.`,
            "</tool_info>",
          ].join("\n"),
          metadata: { activated: params.name },
        }
      }).pipe(Effect.orDie),
  }
}
