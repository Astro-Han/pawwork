export * as ConfigCommand from "./command"

import path from "path"
import { Log } from "../util"
import { Schema } from "effect"
import { NamedError } from "@opencode-ai/util/error"
import { Glob } from "@opencode-ai/core/util/glob"
import { GlobalBus } from "@/bus/global"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"
import { configEntryNameFromPath } from "./entry-name"
import { InvalidError } from "./error"
import * as ConfigMarkdown from "./markdown"
import { ConfigModelID } from "./model-id"

const log = Log.create({ service: "config" })

async function publishSessionError(error: { toObject(): any }) {
  const { Session } = await import("@/session")
  GlobalBus.emit("event", {
    directory: "global",
    payload: { type: Session.Event.Error.type, properties: { error: error.toObject() } },
  })
}

function commandSourceRank(filePath: string) {
  const normalized = filePath.replaceAll("\\", "/")
  if (normalized.includes("/.opencode/command/") || normalized.includes("/command/")) return 0
  return 1
}

async function reportLoadError(error: { toObject(): any }, item: string, cause: unknown) {
  void publishSessionError(error).catch((publishError) => {
    log.error("failed to publish session error event", { command: item, err: publishError })
  })
  log.error("failed to load command", { command: item, err: cause })
}

export const Info = Schema.Struct({
  template: Schema.String,
  description: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  model: Schema.optional(ConfigModelID),
  subtask: Schema.optional(Schema.Boolean),
}).pipe(withStatics((s) => ({ zod: zod(s) })))

export type Info = Schema.Schema.Type<typeof Info>

export async function load(dir: string) {
  const result: Record<string, Info> = {}
  const sources: Record<string, string> = {}
  const items = await Glob.scan("{command,commands}/**/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })
  items.sort((a, b) => commandSourceRank(a) - commandSourceRank(b) || a.localeCompare(b))
  for (const item of items) {
    const md = await ConfigMarkdown.parse(item).catch(async (err) => {
      const message = ConfigMarkdown.FrontmatterError.isInstance(err)
        ? err.data.message
        : `Failed to parse command ${item}`
      await reportLoadError(new NamedError.Unknown({ message }), item, err)
      return undefined
    })
    if (!md) continue

    const name = configEntryNameFromPath(path.relative(dir, item), ["command/", "commands/"])

    const config = {
      ...md.data,
      name,
      template: md.content.trim(),
    }
    const parsed = Info.zod.safeParse(config)
    if (parsed.success) {
      if (config.name in result) {
        await reportLoadError(
          new NamedError.Unknown({
            message: `Duplicate command name "${config.name}" in ${item}; already loaded from ${sources[config.name]}`,
          }),
          item,
          undefined,
        )
        continue
      }
      result[config.name] = parsed.data
      sources[config.name] = item
      continue
    }
    await reportLoadError(
      new InvalidError({ path: item, issues: parsed.error.issues }, { cause: parsed.error }),
      item,
      parsed.error,
    )
  }
  return result
}
