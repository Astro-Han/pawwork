import type { Context, MiddlewareHandler, Next } from "hono"

type JsonBodyLimitInput = {
  maxBytes: number
  tooLarge: (c: Context) => Response | Promise<Response>
  invalidJson: (c: Context) => Response | Promise<Response>
}

export function jsonBodyLimit(input: JsonBodyLimitInput): MiddlewareHandler {
  return async (c, next) => {
    const contentLength = c.req.header("content-length")
    if (contentLength && Number.parseInt(contentLength, 10) > input.maxBytes) {
      return input.tooLarge(c)
    }

    return limitJsonBody(c, next, input)
  }
}

async function limitJsonBody(c: Context, next: Next, input: JsonBodyLimitInput) {
  const body = c.req.raw.body
  if (!body) {
    if (isJsonRequest(c)) return input.invalidJson(c)
    return next()
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > input.maxBytes) {
      await reader.cancel().catch(() => undefined)
      return input.tooLarge(c)
    }
    chunks.push(value)
  }

  const bytes = concatChunks(chunks, total)
  c.req.raw = new Request(c.req.raw, {
    body: bytes,
    duplex: "half",
  } as RequestInit & { duplex: "half" })

  if (isJsonRequest(c) && !hasValidJson(bytes)) return input.invalidJson(c)
  return next()
}

function concatChunks(chunks: Uint8Array[], total: number) {
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function isJsonRequest(c: Context) {
  return c.req.header("content-type")?.includes("json") === true
}

function hasValidJson(bytes: Uint8Array) {
  try {
    JSON.parse(new TextDecoder().decode(bytes))
    return true
  } catch {
    return false
  }
}
