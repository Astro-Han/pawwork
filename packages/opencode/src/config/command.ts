export * as ConfigCommand from "./command"

import { Log } from "../util"
import { Schema } from "effect"
import { NamedError } from "@opencode-ai/util/error"
import { Glob } from "@opencode-ai/shared/util/glob"
import { Bus } from "@/bus"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"
import { configEntryNameFromPath } from "./entry-name"
import { InvalidError } from "./error"
import * as ConfigMarkdown from "./markdown"
import { ConfigModelID } from "./model-id"

const log = Log.create({ service: "config" })

async function reportLoadError(error: { toObject(): any }, item: string, cause: unknown) {
  const { Session } = await import("@/session")
  void Bus.publish(Session.Event.Error, { error: error.toObject() })
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
  for (const item of await Glob.scan("{command,commands}/**/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    const md = await ConfigMarkdown.parse(item).catch(async (err) => {
      const message = ConfigMarkdown.FrontmatterError.isInstance(err)
        ? err.data.message
        : `Failed to parse command ${item}`
      await reportLoadError(new NamedError.Unknown({ message }), item, err)
      return undefined
    })
    if (!md) continue

    const patterns = ["/.opencode/command/", "/.opencode/commands/", "/command/", "/commands/"]
    const name = configEntryNameFromPath(item, patterns)

    const config = {
      ...md.data,
      name,
      template: md.content.trim(),
    }
    const parsed = Info.zod.safeParse(config)
    if (parsed.success) {
      result[config.name] = parsed.data
      continue
    }
    await reportLoadError(new InvalidError({ path: item, issues: parsed.error.issues }, { cause: parsed.error }), item, parsed.error)
  }
  return result
}
