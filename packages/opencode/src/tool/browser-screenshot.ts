import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./browser-screenshot.txt"
import { runBrowserAction, takeoverNote } from "./browser-shared"

export const Parameters = Schema.Struct({
  annotate: Schema.optional(Schema.Boolean).annotate({
    description: "Overlay the latest snapshot's [N] element references onto the image. Default false.",
  }),
})

export const BrowserScreenshotTool = Tool.define(
  "browser_screenshot",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const result = yield* runBrowserAction({
            ctx,
            label: "screenshot",
            run: async (page, info) => {
              // annotatedScreenshot is optional on IPage; degrade to a plain
              // capture instead of failing the tool (design §6).
              const annotated = params.annotate === true && typeof page.annotatedScreenshot === "function"
              const base64 = annotated ? await page.annotatedScreenshot!() : await page.screenshot()
              const url = (await page.getCurrentUrl?.()) ?? ""
              return { base64, annotated, url, info }
            },
          })
          return {
            title: result.url || "Screenshot",
            output:
              `Captured a screenshot of ${result.url || "the current page"}${
                result.annotated ? " with element reference annotations" : ""
              }${params.annotate && !result.annotated ? " (annotation unavailable; plain capture)" : ""}.` +
              takeoverNote(result.info),
            metadata: { url: result.url, annotated: result.annotated },
            attachments: [
              {
                type: "file" as const,
                mime: "image/png",
                url: `data:image/png;base64,${result.base64}`,
              },
            ],
          }
        }),
    }
  }),
)
