import { Effect, Schema } from "effect"
import * as Tool from "../tool"
import { BrowserBridge } from "./bridge"

const MAX_EXTRACT_CHARS = 50_000
const DEFAULT_WAIT_SECONDS = 10
const MAX_WAIT_SECONDS = 60

function ensureAvailable() {
  if (!BrowserBridge.available()) throw new Error(BrowserBridge.UNAVAILABLE_MESSAGE)
}

function tryBridge<T>(label: string, run: () => Promise<T>) {
  return Effect.tryPromise({ try: run, catch: (cause) => new Error(`Browser ${label} failed: ${String(cause)}`) })
}

export const NavigateParameters = Schema.Struct({
  url: Schema.String.annotate({ description: "The URL to open (must start with http:// or https://)." }),
})

export const BrowserNavigateTool = Tool.define(
  "browser_navigate",
  Effect.gen(function* () {
    return {
      description:
        "Open a URL in the PawWork embedded browser. The page renders live in the browser panel; other browser_* tools then act on it.",
      parameters: NavigateParameters,
      execute: (params: Schema.Schema.Type<typeof NavigateParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const url = params.url.trim()
          if (!url.startsWith("http://") && !url.startsWith("https://")) {
            throw new Error("URL must start with http:// or https://")
          }
          ensureAvailable()
          yield* ctx.ask({
            permission: "browser",
            patterns: [url],
            always: ["*"],
            metadata: { action: "navigate", url },
          })
          const result = yield* tryBridge("navigate", () => BrowserBridge.get().navigate({ url }))
          return {
            title: result.title || result.url,
            output: `Navigated to ${result.url}${result.title ? ` — ${result.title}` : ""}`,
            metadata: { url: result.url, pageTitle: result.title },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const ScreenshotParameters = Schema.Struct({})

export const BrowserScreenshotTool = Tool.define(
  "browser_screenshot",
  Effect.gen(function* () {
    return {
      description: "Capture a screenshot of the current page in the embedded browser and return it as an image.",
      parameters: ScreenshotParameters,
      execute: (_params: Schema.Schema.Type<typeof ScreenshotParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          ensureAvailable()
          yield* ctx.ask({
            permission: "browser",
            patterns: ["screenshot"],
            always: ["*"],
            metadata: { action: "screenshot" },
          })
          const shot = yield* tryBridge("screenshot", () => BrowserBridge.get().screenshot())
          return {
            title: "Browser screenshot",
            output: `Captured screenshot (${shot.width}×${shot.height}).`,
            metadata: { width: shot.width, height: shot.height },
            attachments: [
              {
                type: "file" as const,
                mime: shot.mime,
                url: `data:${shot.mime};base64,${shot.base64}`,
              },
            ],
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const ExtractParameters = Schema.Struct({
  selector: Schema.optional(Schema.String).annotate({
    description: "Optional CSS selector to extract text from. Omit to extract the whole page.",
  }),
  maxChars: Schema.optional(Schema.Number).annotate({
    description: `Maximum characters to return (default ${MAX_EXTRACT_CHARS}).`,
  }),
})

export const BrowserExtractTool = Tool.define(
  "browser_extract",
  Effect.gen(function* () {
    return {
      description: "Extract the visible text of the current page (or a CSS selector) from the embedded browser.",
      parameters: ExtractParameters,
      execute: (params: Schema.Schema.Type<typeof ExtractParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          ensureAvailable()
          const maxChars = Math.min(Math.max(1, params.maxChars ?? MAX_EXTRACT_CHARS), MAX_EXTRACT_CHARS)
          yield* ctx.ask({
            permission: "browser",
            patterns: [params.selector ?? "page"],
            always: ["*"],
            metadata: { action: "extract", selector: params.selector },
          })
          const result = yield* tryBridge("extract", () =>
            BrowserBridge.get().extract({ selector: params.selector, maxChars }),
          )
          return {
            title: result.title || result.url,
            output: result.text || "(no text extracted)",
            metadata: { url: result.url, pageTitle: result.title, truncated: result.truncated },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const WaitParameters = Schema.Struct({
  selector: Schema.optional(Schema.String).annotate({ description: "CSS selector to wait for." }),
  text: Schema.optional(Schema.String).annotate({ description: "Visible page text to wait for." }),
  timeout: Schema.optional(Schema.Number).annotate({
    description: `Timeout in seconds (max ${MAX_WAIT_SECONDS}, default ${DEFAULT_WAIT_SECONDS}).`,
  }),
})

export const BrowserWaitTool = Tool.define(
  "browser_wait",
  Effect.gen(function* () {
    return {
      description:
        "Wait until a CSS selector appears, or until some visible text appears, on the current page. Use after an action that loads new content.",
      parameters: WaitParameters,
      execute: (params: Schema.Schema.Type<typeof WaitParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          ensureAvailable()
          if (!params.selector && !params.text) {
            throw new Error("Provide either a selector or text to wait for.")
          }
          const timeoutMs = Math.min(Math.max(1, params.timeout ?? DEFAULT_WAIT_SECONDS), MAX_WAIT_SECONDS) * 1000
          yield* ctx.ask({
            permission: "browser",
            patterns: [params.selector ?? params.text ?? "wait"],
            always: ["*"],
            metadata: { action: "wait", selector: params.selector, text: params.text },
          })
          const result = yield* tryBridge("wait", () =>
            BrowserBridge.get().waitFor({ selector: params.selector, text: params.text, timeoutMs }),
          )
          return {
            title: result.found ? "Wait satisfied" : "Wait timed out",
            output: result.found
              ? `Found after ${result.waitedMs}ms.`
              : `Timed out after ${result.waitedMs}ms waiting for ${params.selector ?? `text "${params.text}"`}.`,
            metadata: { found: result.found, waitedMs: result.waitedMs, reason: result.reason },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const ClickParameters = Schema.Struct({
  selector: Schema.String.annotate({ description: "CSS selector of the element to click." }),
})

export const BrowserClickTool = Tool.define(
  "browser_click",
  Effect.gen(function* () {
    return {
      description: "Click the element matching a CSS selector in the embedded browser (real mouse input at its center).",
      parameters: ClickParameters,
      execute: (params: Schema.Schema.Type<typeof ClickParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          ensureAvailable()
          yield* ctx.ask({
            permission: "browser",
            patterns: [params.selector],
            always: ["*"],
            metadata: { action: "click", selector: params.selector },
          })
          const result = yield* tryBridge("click", () => BrowserBridge.get().click({ selector: params.selector }))
          return {
            title: result.matched ? "Clicked" : "No match",
            output: result.matched
              ? `Clicked ${params.selector} at (${result.x}, ${result.y}).`
              : `No element matched ${params.selector}.`,
            metadata: { matched: result.matched, selector: params.selector },
          }
        }).pipe(Effect.orDie),
    }
  }),
)

export const TypeParameters = Schema.Struct({
  text: Schema.String.annotate({ description: "Text to type." }),
  selector: Schema.optional(Schema.String).annotate({
    description: "CSS selector of the field to type into. Omit to type into the currently focused element.",
  }),
  submit: Schema.optional(Schema.Boolean).annotate({
    description: "Press Enter after typing to submit. Defaults to false.",
  }),
})

export const BrowserTypeTool = Tool.define(
  "browser_type",
  Effect.gen(function* () {
    return {
      description: "Type text into a field in the embedded browser (real keyboard input), optionally submitting with Enter.",
      parameters: TypeParameters,
      execute: (params: Schema.Schema.Type<typeof TypeParameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          ensureAvailable()
          const submit = params.submit ?? false
          yield* ctx.ask({
            permission: "browser",
            patterns: [params.selector ?? "focused"],
            always: ["*"],
            metadata: { action: "type", selector: params.selector, submit },
          })
          const result = yield* tryBridge("type", () =>
            BrowserBridge.get().type({ selector: params.selector, text: params.text, submit }),
          )
          return {
            title: result.matched ? "Typed" : "No match",
            output: result.matched
              ? `Typed ${params.text.length} character(s)${params.selector ? ` into ${params.selector}` : ""}${result.submitted ? " and submitted." : "."}`
              : `No element matched ${params.selector}.`,
            metadata: { matched: result.matched, submitted: result.submitted, selector: params.selector },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
