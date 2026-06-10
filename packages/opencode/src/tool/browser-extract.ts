import { Effect, Schema } from "effect"
import { htmlToMarkdown } from "@jackwener/opencli/utils"
import * as Tool from "./tool"
import DESCRIPTION from "./browser-extract.txt"
import { runBrowserAction, takeoverNote } from "./browser-shared"

/** Per-call markdown budget; long pages page through `start`/`next_start_char`. */
const EXTRACT_CHAR_LIMIT = 16_000

export const Parameters = Schema.Struct({
  selector: Schema.optional(Schema.String).annotate({
    description: "CSS selector to extract from; omit for the whole page body.",
  }),
  start: Schema.optional(Schema.Number).annotate({
    description: "Character offset to continue from (use the previous call's next_start_char).",
  }),
})

// Runs inside the page. The selector arrives pre-serialized via JSON (never
// string-concatenated into code), so selector content cannot inject script.
const READ_HTML_JS = (selectorJson: string) => `(() => {
  const selector = ${selectorJson};
  const el = selector ? document.querySelector(selector) : document.body;
  if (!el) return null;
  return el.outerHTML;
})()`

export const BrowserExtractTool = Tool.define(
  "browser_extract",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const start = Math.max(0, Math.floor(params.start ?? 0))
          const result = yield* runBrowserAction({
            ctx,
            label: "extract",
            metadata: { selector: params.selector },
            run: async (page, info) => {
              // The selector is JSON-serialized into the script (never string-
              // concatenated), so it cannot inject. evaluateWithArgs is avoided
              // on purpose: it injects each arg as a top-level const (the var is
              // `selector`, not `args.selector`), which is easy to get wrong.
              const html = await page.evaluate<string | null>(READ_HTML_JS(JSON.stringify(params.selector ?? null)))
              const url = (await page.getCurrentUrl?.()) ?? ""
              return { html, url, info }
            },
          })
          if (typeof result.html !== "string") {
            return yield* Effect.fail(
              new Error(
                params.selector
                  ? `No element matches selector ${JSON.stringify(params.selector)}.`
                  : "The page has no readable body yet — navigate somewhere first.",
              ),
            )
          }
          const markdown = htmlToMarkdown(result.html)
          const chunk = markdown.slice(start, start + EXTRACT_CHAR_LIMIT)
          const nextStart = start + chunk.length
          const hasMore = nextStart < markdown.length
          return {
            title: result.url || "Extracted content",
            output:
              chunk +
              (hasMore
                ? `\n\n(Content continues — call browser_extract again with start=${nextStart}. next_start_char: ${nextStart})`
                : "") +
              takeoverNote(result.info),
            metadata: {
              url: result.url,
              selector: params.selector,
              start,
              next_start_char: hasMore ? nextStart : undefined,
              total_chars: markdown.length,
            },
          }
        }),
    }
  }),
)
