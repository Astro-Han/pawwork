import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./browser-navigate.txt"
import { parseNavigableUrl } from "@/browser/session"
import { runBrowserAction, takeoverNote } from "./browser-shared"

// Above opencli's internal 30s CDP guard so a slow load surfaces the CDP
// command timeout (which names the navigation) rather than our generic one.
const NAVIGATE_TIMEOUT_MS = 35_000

export const Parameters = Schema.Struct({
  url: Schema.String.annotate({
    description: "Full http:// or https:// URL to open. Other schemes are rejected.",
  }),
})

export const BrowserNavigateTool = Tool.define(
  "browser_navigate",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          // Validate BEFORE goto: CDPPage.goto sends Page.navigate directly,
          // bypassing the view's will-navigate guard, so the scheme check must
          // happen here (design §9).
          const url = parseNavigableUrl(params.url)
          if (!url) {
            return yield* Effect.fail(
              new Error(`Not a navigable URL: ${JSON.stringify(params.url)}. Pass a full http:// or https:// URL.`),
            )
          }
          const result = yield* runBrowserAction({
            ctx,
            label: "navigate",
            patterns: [url],
            metadata: { url },
            timeoutMs: NAVIGATE_TIMEOUT_MS,
            run: async (page, info) => {
              await page.goto(url, { waitUntil: "load" })
              const landed = (await page.getCurrentUrl?.()) ?? url
              const title = await page.evaluate<string>("document.title").catch(() => "")
              return { landed, title, info }
            },
          })
          return {
            title: result.title || result.landed,
            output:
              [`Loaded ${result.landed}`, result.title ? `Title: ${result.title}` : undefined]
                .filter(Boolean)
                .join("\n") + takeoverNote(result.info),
            metadata: { url: result.landed, pageTitle: result.title },
          }
        }),
    }
  }),
)
