import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./opencli-search.txt"
import { searchOpenCliCommands, type OpenCliCommandSummary } from "@/opencli/adapter-registry"
import { highRiskCommandNotice } from "./high-risk-site"

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

export function formatOpenCliSearchOutput(results: OpenCliCommandSummary[]) {
  const body =
    results.length === 0
      ? "No bundled OpenCLI adapter commands matched this query."
      : results.map(formatOpenCliCommand).join("\n\n")
  // Warn at discovery — BEFORE the model decides to run anything — when a matched
  // command targets a high-risk site. Dedupe by notice text so several commands
  // for the same site add a single caution.
  const cautions = [
    ...new Set(
      results
        .map((command) => highRiskCommandNotice(command))
        .filter((notice): notice is string => notice !== null),
    ),
  ]
  // Lead with the cautions: tool output is truncated head-first, so cautions
  // after a long result list could be dropped before the model sees them.
  return cautions.length > 0 ? `${cautions.join("\n\n")}\n\n${body}` : body
}

export const OpenCliSearchTool = Tool.define(
  "opencli_search",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: Effect.fn("OpenCliSearchTool.execute")(function* (params: Schema.Schema.Type<typeof Parameters>) {
        const results = yield* Effect.tryPromise({
          try: () => searchOpenCliCommands(params.query, { limit: params.limit }),
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        })

        return {
          title: `OpenCLI commands for "${params.query}"`,
          output: formatOpenCliSearchOutput(results),
          metadata: { query: params.query, count: results.length },
        }
      }),
    }
  }),
)
