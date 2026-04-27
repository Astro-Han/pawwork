import { Duration, Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"

const BASE_URL = "https://mcp.exa.ai/mcp"

export type Credential = { source: "saved" | "env"; key: string; version?: string } | { source: "anonymous" }

export type FailureKind = "invalid_key" | "quota_exceeded" | "network" | "unknown"

export type Failure = {
  kind: FailureKind
  source: Credential["source"]
  status?: number
  credentialVersion?: string
}

export class McpExaError extends Error {
  constructor(
    readonly failure: Failure,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "McpExaError"
  }
}

export function isMcpExaError(error: unknown): error is McpExaError {
  return error instanceof McpExaError
}

export function credentialFromEnv(env?: { EXA_API_KEY?: string }): Credential {
  const key = (env?.EXA_API_KEY ?? process.env.EXA_API_KEY)?.trim()
  if (key) return { source: "env", key }
  return { source: "anonymous" }
}

export function endpoint(credential: Credential = credentialFromEnv()) {
  if (credential.source === "anonymous") return BASE_URL
  const url = new URL(BASE_URL)
  url.searchParams.set("exaApiKey", credential.key)
  return url.toString()
}

function credentialVersion(credential: Credential) {
  return credential.source === "anonymous" ? undefined : credential.version
}

function statusFromBody(body: string) {
  const errorMatch = body.match(/\berror\s*\(\s*(\d{3})\s*\)/i)
  if (errorMatch?.[1]) return Number(errorMatch[1])
  const statusMatch = body.match(/\b(?:http\s+)?status\s*[:=]\s*(\d{3})\b/i)
  const value =
    statusMatch && /\b(error|failed|failure|invalid|unauthorized|forbidden|quota|rate.?limit)\b/i.test(body)
      ? statusMatch[1]
      : undefined
  return value ? Number(value) : undefined
}

function classifyFailure(input: {
  status?: number
  body: string
  source: Credential["source"]
  credentialVersion?: string
}): Failure {
  const status = input.status ?? statusFromBody(input.body)
  const text = input.body.toLowerCase()
  const base = {
    source: input.source,
    status,
    ...(input.credentialVersion === undefined ? {} : { credentialVersion: input.credentialVersion }),
  }
  if (status === 402 || status === 429 || /quota|rate.?limit|too many requests|usage limit/.test(text)) {
    return { kind: "quota_exceeded", ...base }
  }
  if (status === 401 || status === 403 || /invalid|unauthorized|forbidden|api key/.test(text)) {
    return { kind: "invalid_key", ...base }
  }
  return { kind: "unknown", ...base }
}

function failure(input: { kind: FailureKind; source: Credential["source"]; credentialVersion?: string }): Failure {
  return {
    kind: input.kind,
    source: input.source,
    ...(input.credentialVersion === undefined ? {} : { credentialVersion: input.credentialVersion }),
  }
}

export function messageForFailure(failure: Failure) {
  if (failure.kind === "invalid_key") {
    if (failure.source === "saved") return "The saved Exa API key is invalid. Update or remove it in Settings."
    if (failure.source === "env") return "The EXA_API_KEY environment variable is invalid. Update it and retry."
    return "Exa rejected the anonymous Web Search request."
  }
  if (failure.kind === "quota_exceeded") {
    if (failure.source === "anonymous") {
      return "The bundled Web Search quota was reached. Add an Exa API key in Settings or configure EXA_API_KEY."
    }
    if (failure.source === "saved") return "The saved Exa API key reached its search quota. Update it in Settings."
    return "The EXA_API_KEY search quota was reached. Update the environment variable and retry."
  }
  if (failure.kind === "network") return "Web Search could not reach Exa. Check the network connection and retry."
  return "Web Search failed while contacting Exa. Retry later."
}

const McpResult = Schema.Struct({
  result: Schema.Struct({
    isError: Schema.optional(Schema.Boolean),
    content: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        text: Schema.String,
      }),
    ),
  }),
})

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(McpResult))

const decodeSseData = Effect.fn("McpExa.decodeSseData")(function* (
  payload: string,
  input: { source: Credential["source"]; credentialVersion?: string },
) {
  const data = yield* decode(payload).pipe(
    Effect.mapError(
      (cause) =>
        new McpExaError(
          failure({ kind: "unknown", source: input.source, credentialVersion: input.credentialVersion }),
          "Web Search returned an invalid Exa response.",
          { cause },
        ),
    ),
  )
  const text = data.result.content[0]?.text
  if (data.result.isError) {
    const failure = classifyFailure({ body: text ?? "", ...input })
    return yield* Effect.fail(new McpExaError(failure, messageForFailure(failure)))
  }
  return text
})

const parseSse = Effect.fn("McpExa.parseSse")(function* (
  body: string,
  input: { source: Credential["source"]; credentialVersion?: string },
) {
  let sawData = false
  let eventData: string[] = []

  const flushEvent = Effect.fnUntraced(function* () {
    if (eventData.length === 0) return
    const payload = eventData.join("\n")
    eventData = []
    return yield* decodeSseData(payload, input)
  })

  for (const line of body.split(/\r?\n/)) {
    if (line === "") {
      const text = yield* flushEvent()
      if (text) return text
      continue
    }
    if (!line.startsWith("data:")) continue
    sawData = true
    eventData.push(line.startsWith("data: ") ? line.substring(6) : line.substring(5))
  }

  const text = yield* flushEvent()
  if (text) return text
  const message = sawData ? "Web Search returned an empty Exa response." : "Web Search did not receive an Exa response."
  return yield* Effect.fail(new McpExaError(failure({ kind: "unknown", ...input }), message))
})

export const SearchArgs = Schema.Struct({
  query: Schema.String,
  type: Schema.String,
  numResults: Schema.Number,
  livecrawl: Schema.String,
  contextMaxCharacters: Schema.optional(Schema.Number),
})

export const CodeArgs = Schema.Struct({
  query: Schema.String,
  tokensNum: Schema.Number,
})

const McpRequest = <F extends Schema.Struct.Fields>(args: Schema.Struct<F>) =>
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.Literal(1),
    method: Schema.Literal("tools/call"),
    params: Schema.Struct({
      name: Schema.String,
      arguments: args,
    }),
  })

export const call = <F extends Schema.Struct.Fields>(
  http: HttpClient.HttpClient,
  tool: string,
  args: Schema.Struct<F>,
  value: Schema.Struct.Type<F>,
  timeout: Duration.Input,
  credential: Credential = credentialFromEnv(),
) =>
  Effect.gen(function* () {
    const request = yield* HttpClientRequest.post(endpoint(credential)).pipe(
      HttpClientRequest.accept("application/json, text/event-stream"),
      HttpClientRequest.schemaBodyJson(McpRequest(args))({
        jsonrpc: "2.0" as const,
        id: 1 as const,
        method: "tools/call" as const,
        params: { name: tool, arguments: value },
      }),
    )
    const { response, body } = yield* http.execute(request).pipe(
      Effect.flatMap((response) => response.text.pipe(Effect.map((body) => ({ response, body })))),
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail(
            new McpExaError(
              failure({ kind: "network", source: credential.source, credentialVersion: credentialVersion(credential) }),
              `${tool} request timed out`,
            ),
          ),
      }),
      Effect.mapError((error) =>
        isMcpExaError(error)
          ? error
          : new McpExaError(
              failure({ kind: "network", source: credential.source, credentialVersion: credentialVersion(credential) }),
              "Web Search request failed",
              {
                cause: error,
              },
            ),
      ),
    )
    if (response.status < 200 || response.status >= 300) {
      const failure = classifyFailure({
        status: response.status,
        body,
        source: credential.source,
        credentialVersion: credentialVersion(credential),
      })
      return yield* Effect.fail(new McpExaError(failure, messageForFailure(failure)))
    }
    return yield* parseSse(body, { source: credential.source, credentialVersion: credentialVersion(credential) })
  })
