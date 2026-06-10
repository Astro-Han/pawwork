import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./browser-click.txt"
import { normalizeElementRef, runBrowserAction, takeoverNote } from "./browser-shared"

export const Parameters = Schema.Struct({
  ref: Schema.String.annotate({
    description: 'Element reference from browser_snapshot (like "[12]") or a CSS selector.',
  }),
})

export const BrowserClickTool = Tool.define(
  "browser_click",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const result = yield* runBrowserAction({
            ctx,
            label: "click",
            metadata: { ref: params.ref },
            run: async (page, info) => ({ outcome: await page.click(normalizeElementRef(params.ref)), info }),
          })
          const { matches_n, match_level } = result.outcome
          return {
            title: `Clicked ${params.ref}`,
            output:
              `Clicked ${params.ref} (matched ${matches_n} element${matches_n === 1 ? "" : "s"}, ${match_level} match).` +
              (matches_n > 1 ? " Multiple matches — verify the right element reacted, or re-snapshot for a tighter ref." : "") +
              takeoverNote(result.info),
            metadata: { ref: params.ref, matches: matches_n, matchLevel: match_level },
          }
        }),
    }
  }),
)
