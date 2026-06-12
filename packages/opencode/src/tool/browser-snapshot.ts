import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./browser-snapshot.txt"
import { runBrowserAction, takeoverNote } from "./browser-shared"

export const Parameters = Schema.Struct({
  interactive: Schema.optional(Schema.Boolean).annotate({
    description: "Only list interactive elements (links, buttons, inputs). Default true.",
  }),
  source: Schema.optional(Schema.Literals(["dom", "ax"])).annotate({
    description: 'Observation backend: "dom" (default, stable) or "ax" (accessibility tree, experimental).',
  }),
})

export const BrowserSnapshotTool = Tool.define(
  "browser_snapshot",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const result = yield* runBrowserAction({
            ctx,
            label: "snapshot",
            run: async (page, info) => {
              const snapshot = await page.snapshot({
                interactive: params.interactive ?? true,
                ...(params.source ? { source: params.source } : {}),
              })
              const url = (await page.getCurrentUrl?.()) ?? ""
              return { snapshot, url, info }
            },
          })
          const text =
            typeof result.snapshot === "string" ? result.snapshot : JSON.stringify(result.snapshot, null, 2)
          return {
            title: result.url || "Page snapshot",
            output: text + takeoverNote(result.info),
            metadata: { url: result.url, interactive: params.interactive ?? true },
          }
        }),
    }
  }),
)
