import { Effect, Schema } from "effect"
import { fullName } from "@jackwener/opencli/registry"
import * as Tool from "./tool"
import DESCRIPTION from "./opencli-run.txt"
import {
  openCliCommand,
  openCliCommandSummary,
  openCliCommandSummaryFromCommand,
  type OpenCliCommandSummary,
} from "@/opencli/adapter-registry"
import { coerceOpenCliArgs, prepareOpenCliCommandArgs, runOpenCliAdapterCommand } from "@/opencli/adapter-runner"
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

function commandKnownBrowserPermissionPatterns(command: Pick<OpenCliCommandSummary, "domain" | "navigateBefore">): string[] {
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

function commandMetadata(command: OpenCliCommandSummary, args?: Record<string, unknown>) {
  return {
    action: "opencli_run",
    command: command.name,
    browser: command.browser,
    access: command.access,
    args,
  }
}

function sameJson(left: unknown, right: unknown) {
  try {
    return JSON.stringify(left) === JSON.stringify(right)
  } catch {
    return false
  }
}

function commandPermissionShape(command: OpenCliCommandSummary) {
  return {
    name: command.name,
    access: command.access,
    browser: command.browser,
    domain: command.domain,
    navigateBefore: command.navigateBefore,
  }
}

export function needsFinalOpenCliPermissionAsk(
  preview: OpenCliCommandSummary,
  actual: OpenCliCommandSummary,
  previewArgs: Record<string, unknown>,
  actualArgs: Record<string, unknown>,
) {
  if (!sameJson(commandPermissionShape(preview), commandPermissionShape(actual))) return true
  return !sameJson(previewArgs, actualArgs)
}

function prepareOpenCliPreviewArgs(command: OpenCliCommandSummary, rawArgs: Record<string, unknown>) {
  return coerceOpenCliArgs((command.args ?? []) as Parameters<typeof coerceOpenCliArgs>[0], rawArgs)
}

function askOpenCliAccessPermission(
  ctx: Tool.Context,
  command: OpenCliCommandSummary,
  args: Record<string, unknown>,
) {
  const permission = command.access === "write" ? "opencli_write" : "opencli_read"
  return ctx.ask({
    permission,
    patterns: [command.name],
    always: [command.name],
    metadata: commandMetadata(command, args),
  })
}

function formatAdapterOutput(value: unknown): string {
  if (typeof value === "string") return value
  if (value === undefined || value === null) return "OpenCLI adapter returned no output."
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

async function runNonBrowserCommand(
  command: OpenCliCommand,
  args: Record<string, unknown>,
  abort: AbortSignal,
) {
  const commandName = fullName(command)
  if (abort.aborted) throw new Error(`OpenCLI ${commandName} was canceled.`)
  const writeInterruption =
    command.access === "write"
      ? " The non-browser write adapter may still be running; check the target before retrying."
      : ""
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const interrupted = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`OpenCLI ${commandName} timed out after ${OPENCLI_RUN_TIMEOUT_MS}ms.${writeInterruption}`)),
      OPENCLI_RUN_TIMEOUT_MS,
    )
    onAbort = () => reject(new Error(`OpenCLI ${commandName} was canceled.${writeInterruption}`))
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
    metadata: commandMetadata({
      name: fullName(command),
      description: command.description ?? "",
      access: command.access,
      browser: command.browser !== false,
      domain: command.domain,
      navigateBefore: command.navigateBefore,
      args: command.args,
    }),
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
          const requestedArgs = params.args ?? {}
          const preview = yield* Effect.tryPromise({
            try: () => openCliCommandSummary(params.command),
            catch: (err) => (err instanceof Error ? err : new Error(String(err))),
          })
          if (!preview) {
            return yield* Effect.fail(
              new Error(`Unknown or unsupported OpenCLI command "${params.command}". Run opencli_search to find one.`),
            )
          }
          const previewArgs = prepareOpenCliPreviewArgs(preview, requestedArgs)
          yield* askOpenCliAccessPermission(ctx, preview, previewArgs)
          const command = yield* Effect.tryPromise({
            try: () => openCliCommand(params.command),
            catch: (err) => (err instanceof Error ? err : new Error(String(err))),
          })
          if (!command) {
            return yield* Effect.fail(
              new Error(`OpenCLI command "${params.command}" did not register after its adapter module loaded.`),
            )
          }
          const args = prepareOpenCliCommandArgs(command, requestedArgs)
          const actual = openCliCommandSummaryFromCommand(command)
          if (needsFinalOpenCliPermissionAsk(preview, actual, previewArgs, args)) {
            yield* askOpenCliAccessPermission(ctx, actual, args)
          }

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
