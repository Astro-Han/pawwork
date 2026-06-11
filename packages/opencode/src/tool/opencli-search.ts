import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./opencli-search.txt"
import { searchOpenCliCommands } from "@/opencli/adapter-registry"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({
    description: "Search text: site, command, domain, or task, for example '12306 account' or 'hackernews search'.",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum commands to return. Defaults to 10, max 25.",
  }),
})

export const OpenCliSearchTool = Tool.define(
  "opencli_search",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>) =>
        Effect.tryPromise({
          try: async () => {
            const results = await searchOpenCliCommands(params.query, { limit: params.limit })
            const output =
              results.length === 0
                ? "No bundled OpenCLI adapter commands matched this query."
                : results
                    .map((command) => {
                      const args = (command.args ?? [])
                        .map((arg) => `${arg.name}${arg.required ? " (required)" : ""}`)
                        .join(", ")
                      return [
                        `<opencli_command name="${command.name}">`,
                        `description: ${command.description || "No description"}`,
                        `access: ${command.access}`,
                        `browser: ${command.browser}`,
                        command.domain ? `domain: ${command.domain}` : undefined,
                        args ? `args: ${args}` : "args: none",
                        "</opencli_command>",
                      ]
                        .filter(Boolean)
                        .join("\n")
                    })
                    .join("\n\n")
            return {
              title: `OpenCLI commands for "${params.query}"`,
              output,
              metadata: { query: params.query, count: results.length },
            }
          },
          catch: (err) => (err instanceof Error ? err : new Error(String(err))),
        }),
    }
  }),
)
