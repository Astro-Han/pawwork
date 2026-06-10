import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./browser-type.txt"
import { runBrowserAction, takeoverNote } from "./browser-shared"

export const Parameters = Schema.Struct({
  ref: Schema.String.annotate({
    description: 'Element reference from browser_snapshot (like "[7]") or a CSS selector.',
  }),
  text: Schema.String.annotate({
    description: "Text to fill in; replaces the field's current content.",
  }),
  submit: Schema.optional(Schema.Boolean).annotate({
    description: "Press Enter after filling (for search boxes and single-field forms). Default false.",
  }),
})

export const BrowserTypeTool = Tool.define(
  "browser_type",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const result = yield* runBrowserAction({
            ctx,
            label: "type",
            metadata: { ref: params.ref },
            run: async (page, info) => {
              const outcome = await page.fillText(params.ref, params.text)
              if (params.submit) await page.pressKey("Enter")
              return { outcome, info }
            },
          })
          const { filled, verified, actual, match_level } = result.outcome
          const lines = [
            `Filled ${params.ref} (${match_level} match)${params.submit ? ", then pressed Enter" : ""}.`,
            verified
              ? "Verified: the field contains the requested text."
              : `Not verified — the field now contains: ${JSON.stringify(actual)}`,
          ]
          return {
            title: `Typed into ${params.ref}`,
            output: lines.join("\n") + takeoverNote(result.info),
            metadata: {
              ref: params.ref,
              filled,
              verified,
              submitted: params.submit ?? false,
              matchLevel: match_level,
            },
          }
        }),
    }
  }),
)
