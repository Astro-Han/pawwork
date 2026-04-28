export * as ConfigAgent from "./agent"

import { Schema } from "effect"
import z from "zod"
import { Bus } from "@/bus"
import { zod } from "@/util/effect-zod"
import { Log } from "../util"
import { NamedError } from "@opencode-ai/util/error"
import { Glob } from "@opencode-ai/core/util/glob"
import { configEntryNameFromPath } from "./entry-name"
import { InvalidError } from "./error"
import * as ConfigMarkdown from "./markdown"
import { ConfigModelID } from "./model-id"
import { ConfigPermission } from "./permission"

const log = Log.create({ service: "config" })

const PositiveInt = Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThan(0))

const Color = Schema.Union([
  Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
  Schema.Literals(["primary", "secondary", "accent", "success", "warning", "error", "info"]),
])

const AgentSchema = Schema.StructWithRest(
  Schema.Struct({
    model: Schema.optional(ConfigModelID),
    variant: Schema.optional(Schema.String).annotate({
      description: "Default model variant for this agent (applies only when using the agent's configured model).",
    }),
    temperature: Schema.optional(Schema.Number),
    top_p: Schema.optional(Schema.Number),
    prompt: Schema.optional(Schema.String),
    tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)).annotate({
      description: "@deprecated Use 'permission' field instead",
    }),
    disable: Schema.optional(Schema.Boolean),
    description: Schema.optional(Schema.String).annotate({ description: "Description of when to use the agent" }),
    mode: Schema.optional(Schema.Literals(["subagent", "primary", "all"])),
    hidden: Schema.optional(Schema.Boolean).annotate({
      description: "Hide this subagent from the @ autocomplete menu (default: false, only applies to mode: subagent)",
    }),
    options: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
    color: Schema.optional(Color).annotate({
      description: "Hex color code (e.g., #FF5733) or theme color (e.g., primary)",
    }),
    steps: Schema.optional(PositiveInt).annotate({
      description: "Maximum number of agentic iterations before forcing text-only response",
    }),
    maxSteps: Schema.optional(PositiveInt).annotate({ description: "@deprecated Use 'steps' field instead." }),
    permission: Schema.optional(ConfigPermission.Info),
  }),
  [Schema.Record(Schema.String, Schema.Any)],
)

const KNOWN_KEYS = new Set([
  "name",
  "model",
  "variant",
  "prompt",
  "description",
  "temperature",
  "top_p",
  "mode",
  "hidden",
  "color",
  "steps",
  "maxSteps",
  "options",
  "permission",
  "disable",
  "tools",
])

type AgentInput = Schema.Schema.Type<typeof AgentSchema>
type AgentInfo = Omit<AgentInput, "maxSteps" | "options" | "permission" | "steps" | "tools"> & {
  options?: Record<string, unknown>
  permission?: ConfigPermission.Info
  steps?: number
}

// Post-parse normalisation:
//  - Promote any unknown-but-present keys into `options` so they survive the
//    round-trip in a well-known field.
//  - Translate the deprecated `tools: { name: boolean }` map into the new
//    `permission` shape (write-adjacent tools collapse into `permission.edit`).
//  - Coalesce `steps ?? maxSteps` so downstream can ignore the deprecated alias.
const normalize = (agent: AgentInput): AgentInfo => {
  const {
    maxSteps,
    options: agentOptions,
    permission: configuredPermission,
    steps,
    tools,
    ...rest
  } = agent
  const options: Record<string, unknown> = { ...agentOptions }
  for (const [key, value] of Object.entries(agent)) {
    if (!KNOWN_KEYS.has(key)) options[key] = value
  }

  const permission: ConfigPermission.Info = {}
  for (const [tool, enabled] of Object.entries(tools ?? {})) {
    const action = enabled ? "allow" : "deny"
    if (tool === "write" || tool === "edit" || tool === "patch") {
      permission.edit = action
      continue
    }
    permission[tool] = action
  }
  // The new permission config wins when it conflicts with deprecated tools.
  Object.assign(permission, configuredPermission)

  return { ...rest, options, permission, steps: steps ?? maxSteps }
}

export const Info = zod(AgentSchema).transform(normalize).meta({ ref: "AgentConfig" }) as unknown as z.ZodType<AgentInfo>
export type Info = z.infer<typeof Info>

async function reportLoadError(error: { toObject(): any }, context: Record<string, unknown>) {
  const { Session } = await import("@/session")
  void Bus.publish(Session.Event.Error, { error: error.toObject() })
  log.error("failed to load agent", context)
}

export async function load(dir: string) {
  const result: Record<string, Info> = {}
  for (const item of await Glob.scan("{agent,agents}/**/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    const md = await ConfigMarkdown.parse(item).catch(async (err) => {
      const message = ConfigMarkdown.FrontmatterError.isInstance(err)
        ? err.data.message
        : `Failed to parse agent ${item}`
      const { Session } = await import("@/session")
      void Bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
      log.error("failed to load agent", { agent: item, err })
      return undefined
    })
    if (!md) continue

    const patterns = ["/.opencode/agent/", "/.opencode/agents/", "/agent/", "/agents/"]
    const name = configEntryNameFromPath(item, patterns)

    const config = {
      ...md.data,
      name,
      prompt: md.content.trim(),
    }
    const parsed = Info.safeParse(config)
    if (parsed.success) {
      result[config.name] = parsed.data
      continue
    }
    const error = new InvalidError({ path: item, issues: parsed.error.issues }, { cause: parsed.error })
    await reportLoadError(error, { agent: item, err: parsed.error })
  }
  return result
}

export async function loadMode(dir: string) {
  const result: Record<string, Info> = {}
  for (const item of await Glob.scan("{mode,modes}/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    const md = await ConfigMarkdown.parse(item).catch(async (err) => {
      const message = ConfigMarkdown.FrontmatterError.isInstance(err)
        ? err.data.message
        : `Failed to parse mode ${item}`
      const { Session } = await import("@/session")
      void Bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
      log.error("failed to load mode", { mode: item, err })
      return undefined
    })
    if (!md) continue

    const config = {
      ...md.data,
      name: configEntryNameFromPath(item, []),
      prompt: md.content.trim(),
    }
    const parsed = Info.safeParse(config)
    if (parsed.success) {
      result[config.name] = {
        ...parsed.data,
        mode: "primary" as const,
      }
      continue
    }
    const error = new InvalidError({ path: item, issues: parsed.error.issues }, { cause: parsed.error })
    await reportLoadError(error, { mode: item, err: parsed.error })
  }
  return result
}
