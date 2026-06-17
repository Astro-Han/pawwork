import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./browser-navigate.txt"
import { parseNavigableUrl } from "@/browser/session"
import { browserAlwaysPatterns, runBrowserAction, withNotes } from "./browser-shared"
import { highRiskSiteNotice } from "./high-risk-site"

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
      execute: Effect.fn("BrowserNavigateTool.execute")(function* (
        params: Schema.Schema.Type<typeof Parameters>,
        ctx: Tool.Context,
      ) {
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
            // Read the document's real location: goto caches the REQUESTED
            // url, so getCurrentUrl() would just echo it back and a redirect
            // would never be visible — to the user or to the re-judge below.
            const landed = await page.evaluate<string>("window.location.href").catch(() => url)
            const title = await page.evaluate<string>("document.title").catch(() => "")
            return { landed: typeof landed === "string" && landed ? landed : url, title, info }
          },
        })
        // A redirect can land on a different URL than the one the permission
        // was granted for; re-judge the landing so a configured deny on the
        // destination still applies. The page has loaded by now (a redirect
        // can't be vetoed without intercepting the request), but the action
        // fails loudly and every later action probes the denied page anyway.
        // Same-string landings — the common case — skip this entirely.
        const landed = parseNavigableUrl(result.landed)
        if (landed && landed !== url) {
          yield* ctx.ask({
            permission: "browser",
            patterns: [landed],
            always: browserAlwaysPatterns([landed]),
            metadata: { action: "navigate", url: landed, redirectedFrom: url },
          })
        }
        // The centralized notice keys on the REQUESTED url; a redirect can land
        // on a high-risk site the request never named. Fall back to the landed-url
        // caution when the centralized one didn't fire (so no dupe), and let
        // withNotes lead the output with whichever applies.
        const info = {
          ...result.info,
          highRiskNotice: result.info.highRiskNotice ?? highRiskSiteNotice(result.landed),
        }
        return {
          title: result.title || result.landed,
          output: withNotes(
            info,
            [`Loaded ${result.landed}`, result.title ? `Title: ${result.title}` : undefined]
              .filter(Boolean)
              .join("\n"),
          ),
          metadata: { url: result.landed, pageTitle: result.title },
        }
      }),
    }
  }),
)
