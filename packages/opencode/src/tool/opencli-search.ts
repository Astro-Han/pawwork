import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./opencli-search.txt"
import {
  loadOpenCliAdapters,
  searchOpenCliCommands,
  type OpenCliAdapterImportFailure,
  type OpenCliCommandSummary,
} from "@/opencli/adapter-registry"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({
    description: "Search text: site, command, domain, or task, for example '12306 account' or 'hackernews search'.",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum commands to return. Defaults to 10, max 25.",
  }),
})

function formatOpenCliCommand(command: OpenCliCommandSummary) {
  const args = (command.args ?? [])
    .map((arg) => {
      const details = [`${arg.name}${arg.required ? " (required)" : ""}`]
      if (arg.type) details.push(`type: ${arg.type}`)
      if (arg.choices && arg.choices.length > 0) details.push(`choices: [${arg.choices.join(", ")}]`)
      if (arg.default !== undefined) details.push(`default: ${JSON.stringify(arg.default)}`)
      if (arg.help) details.push(`help: ${arg.help}`)
      return `- ${details.join(" | ")}`
    })
    .join("\n")
  return [
    `<opencli_command name="${command.name}">`,
    `description: ${command.description || "No description"}`,
    `access: ${command.access}`,
    `browser: ${command.browser}`,
    command.domain ? `domain: ${command.domain}` : undefined,
    args ? `args:\n${args}` : "args: none",
    "</opencli_command>",
  ]
    .filter(Boolean)
    .join("\n")
}

function formatAdapterFailureWarning(failedModules: OpenCliAdapterImportFailure[]) {
  if (failedModules.length === 0) return undefined
  const sample = failedModules.slice(0, 3).map((failure) => failure.modulePath)
  const more = failedModules.length > sample.length ? `, and ${failedModules.length - sample.length} more` : ""
  const noun = failedModules.length === 1 ? "module" : "modules"
  return `Warning: ${failedModules.length} OpenCLI adapter ${noun} failed to load (${sample.join(", ")}${more}); some commands may be missing.`
}

export function formatOpenCliSearchOutput(
  results: OpenCliCommandSummary[],
  failedModules: OpenCliAdapterImportFailure[] = [],
) {
  const body =
    results.length === 0
      ? "No bundled OpenCLI adapter commands matched this query."
      : results.map(formatOpenCliCommand).join("\n\n")
  return [body, formatAdapterFailureWarning(failedModules)].filter(Boolean).join("\n\n")
}

export const OpenCliSearchTool = Tool.define(
  "opencli_search",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>) =>
        Effect.tryPromise({
          try: async () => {
            const loaded = await loadOpenCliAdapters()
            const results = await searchOpenCliCommands(params.query, { limit: params.limit })
            return {
              title: `OpenCLI commands for "${params.query}"`,
              output: formatOpenCliSearchOutput(results, loaded.failedModules),
              metadata: { query: params.query, count: results.length, failedModuleCount: loaded.failedModules.length },
            }
          },
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }),
    }
  }),
)
