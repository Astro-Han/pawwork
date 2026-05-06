import { Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import * as Tool from "./tool"
import TurndownService from "turndown"
import DESCRIPTION from "./webfetch.txt"
import { isImageAttachment } from "@/util/media"

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024 // 5MB
const DEFAULT_TIMEOUT = 30 * 1000 // 30 seconds
const MAX_TIMEOUT = 120 * 1000 // 2 minutes

export const Parameters = Schema.Struct({
  url: Schema.String.annotate({ description: "The URL to fetch content from" }),
  format: Schema.Literals(["text", "markdown", "html"])
    .pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed("markdown" as const)))
    .annotate({
      description: "The format to return the content in (text, markdown, or html). Defaults to markdown.",
    }),
  timeout: Schema.optional(Schema.Number).annotate({ description: "Optional timeout in seconds (max 120)" }),
})

export const WebFetchTool = Tool.define(
  "webfetch",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(http)

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
            throw new Error("URL must start with http:// or https://")
          }
          if (params.timeout !== undefined && (!(params.timeout > 0) || params.timeout > 120)) {
            throw new Error("timeout must be a positive number of seconds (max 120)")
          }

          yield* ctx.ask({
            permission: "webfetch",
            patterns: [params.url],
            always: ["*"],
            metadata: {
              url: params.url,
              format: params.format,
              timeout: params.timeout,
            },
          })

          const timeout = Math.min((params.timeout ?? DEFAULT_TIMEOUT / 1000) * 1000, MAX_TIMEOUT)

          // Build Accept header based on requested format with q parameters for fallbacks
          let acceptHeader = "*/*"
          switch (params.format) {
            case "markdown":
              acceptHeader = "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
              break
            case "text":
              acceptHeader = "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
              break
            case "html":
              acceptHeader =
                "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
              break
            default:
              acceptHeader =
                "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"
          }
          const headers = {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
            Accept: acceptHeader,
            "Accept-Language": "en-US,en;q=0.9",
          }

          const request = HttpClientRequest.get(params.url).pipe(HttpClientRequest.setHeaders(headers))

          // Retry with honest UA if blocked by Cloudflare bot detection (TLS fingerprint mismatch)
          const response = yield* httpOk.execute(request).pipe(
            Effect.catchIf(
              (err) =>
                err.reason._tag === "StatusCodeError" &&
                err.reason.response.status === 403 &&
                err.reason.response.headers["cf-mitigated"] === "challenge",
              () =>
                httpOk.execute(
                  HttpClientRequest.get(params.url).pipe(
                    HttpClientRequest.setHeaders({ ...headers, "User-Agent": "opencode" }),
                  ),
                ),
            ),
            Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.die(new Error("Request timed out")) }),
          )

          // Check content length
          const contentLength = response.headers["content-length"]
          if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
            throw new Error("Response too large (exceeds 5MB limit)")
          }

          const arrayBuffer = yield* response.arrayBuffer
          if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) {
            throw new Error("Response too large (exceeds 5MB limit)")
          }

          const contentType = response.headers["content-type"] || ""
          const mime = contentType.split(";")[0]?.trim().toLowerCase() || ""
          const title = `${params.url} (${contentType})`

          if (isImageAttachment(mime)) {
            const base64Content = Buffer.from(arrayBuffer).toString("base64")
            return {
              title,
              output: "Image fetched successfully",
              metadata: {},
              attachments: [
                {
                  type: "file" as const,
                  mime,
                  url: `data:${mime};base64,${base64Content}`,
                },
              ],
            }
          }

          const content = new TextDecoder().decode(arrayBuffer)

          // Handle content based on requested format and actual content type
          switch (params.format) {
            case "markdown":
              if (contentType.includes("text/html")) {
                const markdown = convertHTMLToMarkdown(content)
                return {
                  output: markdown,
                  title,
                  metadata: {},
                }
              }
              return { output: content, title, metadata: {} }

            case "text":
              if (contentType.includes("text/html")) {
                const text = yield* Effect.promise(() => extractTextFromHTML(content))
                return { output: text, title, metadata: {} }
              }
              return { output: content, title, metadata: {} }

            case "html":
              return { output: content, title, metadata: {} }

            default:
              return { output: content, title, metadata: {} }
          }
        }).pipe(Effect.orDie),
    }
  }),
)

async function extractTextFromHTML(html: string) {
  return normalizeExtractedText(decodeHTMLEntities(scanHTMLText(html)))
}

const SKIP_TEXT_TAGS = new Set(["script", "style", "noscript", "iframe", "object", "embed"])
const BREAK_TAGS = new Set([
  "article",
  "aside",
  "body",
  "br",
  "div",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "section",
  "table",
  "tr",
  "ul",
])

function scanHTMLText(html: string) {
  const all: string[] = []
  const body: string[] = []
  let sawBody = false
  let inBody = false
  let skipTag: string | undefined
  let index = 0

  const append = (text: string) => {
    all.push(text)
    if (inBody) body.push(text)
  }

  while (index < html.length) {
    if (html[index] !== "<") {
      const next = html.indexOf("<", index)
      const end = next === -1 ? html.length : next
      if (!skipTag) append(html.slice(index, end))
      index = end
      continue
    }

    if (html.startsWith("<!--", index)) {
      const end = html.indexOf("-->", index + 4)
      index = end === -1 ? html.length : end + 3
      continue
    }

    const tag = readTag(html, index)
    if (!tag) {
      if (!skipTag) append("<")
      index += 1
      continue
    }

    if (skipTag) {
      if (tag.closing && tag.name === skipTag) skipTag = undefined
      index = tag.end + 1
      continue
    }

    if (tag.name === "body") {
      sawBody = true
      inBody = !tag.closing
      index = tag.end + 1
      continue
    }

    if (!tag.closing && SKIP_TEXT_TAGS.has(tag.name)) {
      skipTag = tag.name
      index = tag.end + 1
      continue
    }

    if (BREAK_TAGS.has(tag.name)) append("\n")
    index = tag.end + 1
  }

  return (sawBody ? body : all).join("")
}

function readTag(html: string, start: number) {
  const end = findTagEnd(html, start + 1)
  if (end === -1) return

  let index = start + 1
  while (/\s/.test(html[index] ?? "")) index++
  const closing = html[index] === "/"
  if (closing) {
    index++
    while (/\s/.test(html[index] ?? "")) index++
  }

  const nameStart = index
  while (/[A-Za-z0-9:-]/.test(html[index] ?? "")) index++
  if (index === nameStart) return { closing, end, name: "" }
  return { closing, end, name: html.slice(nameStart, index).toLowerCase() }
}

function findTagEnd(html: string, start: number) {
  let quote: string | undefined
  for (let index = start; index < html.length; index++) {
    const char = html[index]
    if (quote) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char === ">") return index
  }
  return -1
}

function normalizeExtractedText(text: string) {
  return text
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function decodeHTMLEntities(text: string) {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  }
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (match, entity: string) => {
    const lower = entity.toLowerCase()
    if (lower.startsWith("#x")) {
      const codePoint = Number.parseInt(lower.slice(2), 16)
      return validCodePoint(codePoint) ? String.fromCodePoint(codePoint) : match
    }
    if (lower.startsWith("#")) {
      const codePoint = Number.parseInt(lower.slice(1), 10)
      return validCodePoint(codePoint) ? String.fromCodePoint(codePoint) : match
    }
    return named[lower] ?? match
  })
}

function validCodePoint(value: number) {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff
}

function convertHTMLToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  turndownService.remove(["script", "style", "meta", "link"])
  return turndownService.turndown(html)
}
