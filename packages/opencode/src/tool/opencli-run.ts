import { Effect, Schema } from "effect"
import { fullName } from "@jackwener/opencli/registry"
import * as Tool from "./tool"
import DESCRIPTION from "./opencli-run.txt"
import { openCliCommand } from "@/opencli/adapter-registry"
import { prepareOpenCliCommandArgs, runOpenCliAdapterCommand } from "@/opencli/adapter-runner"
import { browserAlwaysPatterns } from "./browser-shared"
import { withBrowserPage } from "@/browser/session"

export const Parameters = Schema.Struct({
  command: Schema.String.annotate({
    description: "Exact OpenCLI adapter command name, for example 'hackernews/search' or '12306/me'.",
  }),
  args: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({
    description: "Adapter arguments by name. Use opencli_search to inspect available args.",
  }),
})

function commandPermissionPatterns(command: Awaited<ReturnType<typeof openCliCommand>>): string[] {
  if (!command) return ["*"]
  const patterns: string[] = []
  if (typeof command.navigateBefore === "string") {
    try {
      patterns.push(`${new URL(command.navigateBefore).origin}/*`)
    } catch {
      patterns.push(command.navigateBefore)
    }
  }
  if (command.domain) patterns.push(`https://${command.domain}/*`)
  return patterns.length > 0 ? [...new Set(patterns)] : ["*"]
}

function formatAdapterOutput(value: unknown): string {
  if (typeof value === "string") return value
  return JSON.stringify(value, null, 2)
}

export const OpenCliRunTool = Tool.define(
  "opencli_run",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const command = yield* Effect.tryPromise({
            try: () => openCliCommand(params.command),
            catch: (err) => (err instanceof Error ? err : new Error(String(err))),
          })
          if (!command) {
            return yield* Effect.fail(
              new Error(`Unknown or unsupported OpenCLI command "${params.command}". Run opencli_search to find one.`),
            )
          }
          const args = prepareOpenCliCommandArgs(command, params.args ?? {})
          if (command.browser !== false) {
            const patterns = commandPermissionPatterns(command)
            yield* ctx.ask({
              permission: "browser",
              patterns,
              always: browserAlwaysPatterns(patterns),
              metadata: { action: "opencli_run", command: fullName(command), browser: true },
            })
          }

          const value = command.browser === false
            ? yield* Effect.tryPromise({
                try: () => runOpenCliAdapterCommand(command, null, args),
                catch: (err) => (err instanceof Error ? err : new Error(String(err))),
              })
            : yield* Effect.tryPromise({
                try: () =>
                  withBrowserPage(ctx.sessionID, `opencli ${fullName(command)}`, (page) =>
                    runOpenCliAdapterCommand(command, page, args),
                    { timeoutMs: 60_000, abort: ctx.abort },
                  ),
                catch: (err) => (err instanceof Error ? err : new Error(String(err))),
              })

          return {
            title: `OpenCLI ${fullName(command)}`,
            output: formatAdapterOutput(value),
            metadata: {
              command: fullName(command),
              access: command.access,
              browser: command.browser !== false,
              domain: command.domain,
            },
          }
        }),
    }
  }),
)
