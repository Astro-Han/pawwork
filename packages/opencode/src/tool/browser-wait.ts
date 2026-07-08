import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./browser-wait.txt"
import { runBrowserAction, withNotes } from "./browser-shared"

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
      execute: Effect.fn("BrowserWaitTool.execute")(function* (
        params: Schema.Schema.Type<typeof Parameters>,
        ctx: Tool.Context,
      ) {
        const conditions = [params.text, params.selector, params.time].filter((v) => v !== undefined)
        if (conditions.length !== 1) {
          return yield* Effect.fail(new Error("Provide exactly one of `text`, `selector`, or `time`."))
        }
        // The checks below are truthy-based; a blank string would slip past
        // the count above and turn into a meaningless bare-timeout wait.
        for (const [key, value] of [
          ["text", params.text],
          ["selector", params.selector],
        ] as const) {
          if (value !== undefined && value.trim() === "") {
            return yield* Effect.fail(new Error(`\`${key}\` must be a non-empty string.`))
          }
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
        const info = yield* runBrowserAction({
          ctx,
          label: "wait",
          metadata: { condition },
          // The page-side wait owns the deadline; give the tool wrapper room past it.
          timeoutMs: (requested + 5) * 1000,
          run: async (page, info) => {
            if (params.time !== undefined) {
              await page.wait({ time: requested })
              return info
            }
            try {
              await page.wait({
                ...(params.text ? { text: params.text } : {}),
                ...(params.selector ? { selector: params.selector } : {}),
                timeout: requested,
              })
            } catch (err) {
              // The page-side waiter rejects with a raw in-page exception
              // ("Evaluate error: ... Selector not found ... at <anonymous>"),
              // which neither says it was a timeout nor how to recover. Say both.
              if (err instanceof Error && /Selector not found|Text not found/.test(err.message)) {
                throw new Error(
                  `Waited ${requested}s but ${condition} never appeared. The page may be structured differently than expected — take a browser_snapshot to see what is actually there before retrying.`,
                )
              }
              throw err
            }
            return info
          },
        })
        return {
          title: `Waited for ${condition}`,
          // When taking over an already-open page reloaded it, say so — a
          // wait may be the takeover's first action, and the condition it
          // just satisfied happened on the freshly reloaded document.
          output: withNotes(info, `Done: ${condition}.`),
          metadata: { condition },
        }
      }),
    }
  }),
)
