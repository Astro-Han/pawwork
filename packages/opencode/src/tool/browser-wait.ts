import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./browser-wait.txt"
import { runBrowserAction } from "./browser-shared"

const MAX_WAIT_SECONDS = 120

export const Parameters = Schema.Struct({
  text: Schema.optional(Schema.String).annotate({
    description: "Wait until this text is visible on the page.",
  }),
  selector: Schema.optional(Schema.String).annotate({
    description: "Wait until this CSS selector matches an element.",
  }),
  time: Schema.optional(Schema.Number).annotate({
    description: "Fixed pause in seconds (use only when nothing observable signals readiness).",
  }),
  timeout: Schema.optional(Schema.Number).annotate({
    description: "Wait limit in seconds for text/selector waits (defaults: text 30s, selector 10s).",
  }),
})

export const BrowserWaitTool = Tool.define(
  "browser_wait",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const conditions = [params.text, params.selector, params.time].filter((v) => v !== undefined)
          if (conditions.length !== 1) {
            return yield* Effect.fail(new Error("Provide exactly one of `text`, `selector`, or `time`."))
          }
          const requested = Math.min(
            params.time ?? params.timeout ?? (params.selector ? 10 : 30),
            MAX_WAIT_SECONDS,
          )
          if (requested <= 0) {
            return yield* Effect.fail(new Error("`time`/`timeout` must be a positive number of seconds."))
          }
          const condition = params.text
            ? `text ${JSON.stringify(params.text)}`
            : params.selector
              ? `selector ${JSON.stringify(params.selector)}`
              : `${requested}s pause`
          yield* runBrowserAction({
            ctx,
            label: "wait",
            metadata: { condition },
            // The page-side wait owns the deadline; give the tool wrapper room past it.
            timeoutMs: (requested + 5) * 1000,
            run: async (page) => {
              if (params.time !== undefined) {
                await page.wait({ time: requested })
                return
              }
              await page.wait({
                ...(params.text ? { text: params.text } : {}),
                ...(params.selector ? { selector: params.selector } : {}),
                timeout: requested,
              })
            },
          })
          return {
            title: `Waited for ${condition}`,
            output: `Done: ${condition}.`,
            metadata: { condition },
          }
        }),
    }
  }),
)
