import { Effect, Schema } from "effect"
import { fullName } from "@jackwener/opencli/registry"
import * as Tool from "./tool"
import DESCRIPTION from "./opencli-run.txt"
import { openCliCommand } from "@/opencli/adapter-registry"
import { prepareOpenCliCommandArgs, runOpenCliAdapterCommand } from "@/opencli/adapter-runner"
import { runBrowserAction } from "./browser-shared"

const OPENCLI_RUN_TIMEOUT_MS = 60_000
type OpenCliCommand = NonNullable<Awaited<ReturnType<typeof openCliCommand>>>

export const Parameters = Schema.Struct({
  command: Schema.String.annotate({
    description: "Exact OpenCLI adapter command name, for example 'hackernews/search' or '12306/me'.",
  }),
  args: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({
    description: "Adapter arguments by name. Use opencli_search to inspect available args.",
  }),
})

function commandKnownBrowserPermissionPatterns(command: OpenCliCommand): string[] {
  if (typeof command.navigateBefore !== "string") return []
  const patterns: string[] = []
  try {
    patterns.push(`${new URL(command.navigateBefore).origin}/*`)
  } catch {
    patterns.push(command.navigateBefore)
  }
  if (command.domain) patterns.push(`https://${command.domain}/*`)
  return [...new Set(patterns)]
}

function commandMetadata(command: OpenCliCommand) {
  return {
    action: "opencli_run",
    command: fullName(command),
    browser: command.browser !== false,
    access: command.access,
  }
}

function askOpenCliWritePermission(ctx: Tool.Context, command: OpenCliCommand) {
  const commandName = fullName(command)
  return ctx.ask({
    permission: "opencli_write",
    patterns: [commandName],
    always: [commandName],
    metadata: commandMetadata(command),
  })
}

function formatAdapterOutput(value: unknown): string {
  if (typeof value === "string") return value
  return JSON.stringify(value, null, 2)
}

async function runNonBrowserCommand(
  command: OpenCliCommand,
  args: Record<string, unknown>,
  abort: AbortSignal,
) {
  const commandName = fullName(command)
  if (abort.aborted) throw new Error(`OpenCLI ${commandName} was canceled.`)
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const interrupted = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`OpenCLI ${commandName} timed out after ${OPENCLI_RUN_TIMEOUT_MS}ms.`)),
      OPENCLI_RUN_TIMEOUT_MS,
    )
    onAbort = () => reject(new Error(`OpenCLI ${commandName} was canceled.`))
    abort.addEventListener("abort", onAbort, { once: true })
  })
  const running = runOpenCliAdapterCommand(command, null, args)
  running.catch(() => {})
  try {
    return await Promise.race([running, interrupted])
  } finally {
    clearTimeout(timer)
    if (onAbort) abort.removeEventListener("abort", onAbort)
  }
}

function runBrowserCommand(command: OpenCliCommand, args: Record<string, unknown>, ctx: Tool.Context) {
  const patterns = commandKnownBrowserPermissionPatterns(command)
  return runBrowserAction({
    ctx,
    label: `opencli ${fullName(command)}`,
    patterns: patterns.length > 0 ? patterns : undefined,
    metadata: commandMetadata(command),
    timeoutMs: OPENCLI_RUN_TIMEOUT_MS,
    run: (page) => runOpenCliAdapterCommand(command, page, args),
  })
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
          if (command.access === "write") yield* askOpenCliWritePermission(ctx, command)

          const value = command.browser === false
            ? yield* Effect.tryPromise({
                try: () => runNonBrowserCommand(command, args, ctx.abort),
                catch: (err) => (err instanceof Error ? err : new Error(String(err))),
              })
            : yield* runBrowserCommand(command, args, ctx)

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
