export * from "./gen/types.gen.js"

import { createClient } from "./gen/client/client.gen.js"
import { type Config } from "./gen/client/types.gen.js"
import { OpencodeClient } from "./gen/sdk.gen.js"
import type {
  AppAgentsResponse,
  CommandListResponse,
  FileListResponse,
  FileReadResponse,
  LspStatusResponse,
  McpStatusResponse,
  PathGetResponse,
  VcsGetResponse,
} from "./gen/types.gen.js"
export { type Config as OpencodeClientConfig, OpencodeClient }

export type FileNode = FileListResponse[number]
export type FileContent = FileReadResponse
export type McpStatus = McpStatusResponse[string]
export type Path = PathGetResponse
export type VcsInfo = VcsGetResponse
export type VcsFileDiff = {
  file: string
  patch: string
  additions: number
  deletions: number
  status?: "added" | "deleted" | "modified"
}
export type Command = CommandListResponse[number]
export type Agent = AppAgentsResponse[number]
export type LspStatus = LspStatusResponse[number]

function pick(value: string | null, fallback?: string, encode?: (value: string) => string) {
  if (!value) return
  if (!fallback) return value
  if (value === fallback) return fallback
  if (encode && value === encode(fallback)) return fallback
  return value
}

function rewrite(request: Request, values: { directory?: string; workspace?: string }) {
  if (request.method !== "GET" && request.method !== "HEAD") return request

  const url = new URL(request.url)
  let changed = false

  for (const [name, key] of [
    ["x-opencode-directory", "directory"],
    ["x-opencode-workspace", "workspace"],
  ] as const) {
    const value = pick(
      request.headers.get(name),
      key === "directory" ? values.directory : values.workspace,
      key === "directory" ? encodeURIComponent : undefined,
    )
    if (!value) continue
    if (!url.searchParams.has(key)) {
      url.searchParams.set(key, value)
    }
    changed = true
  }

  if (!changed) return request

  const next = new Request(url, request)
  next.headers.delete("x-opencode-directory")
  next.headers.delete("x-opencode-workspace")
  return next
}

/**
 * Wrap whatever the generated client decoded from a non-2xx error body into a
 * real `Error` so downstream formatters (TUI, CLI `run`, ACP, plugins) get a
 * useful `.message` instead of `[object Object]` or a bare `{}`. The original
 * parsed body and status stay under `.cause` for callers that need structured
 * fields.
 *
 * Empty / unparseable bodies and network failures are wrapped unconditionally
 * (matching the prior behavior of this interceptor). Non-empty structured or
 * string bodies are only wrapped on the `{ throwOnError: true }` path; the
 * result-tuple path keeps the raw parsed body so existing `result.error.<field>`
 * reads stay byte-for-byte identical.
 */
export function wrapClientError(
  error: unknown,
  response: Response | undefined,
  request: Request | undefined,
  opts: { throwOnError?: boolean } | undefined,
): unknown {
  if (error instanceof Error) return error

  const isEmpty =
    error === undefined ||
    error === null ||
    error === "" ||
    (typeof error === "object" && Object.keys(error).length === 0)

  if (isEmpty) {
    const reason = response ? "(empty response body)" : "network error (no response)"
    return new Error(`opencode server ${describeRequest(request, response)}: ${reason}`, {
      cause: { body: error, status: response?.status },
    })
  }

  if (!opts?.throwOnError) return error

  // opencode 4xx NamedError bodies arrive as POJOs — extract a useful message.
  if (typeof error === "object") {
    const obj = error as { data?: { message?: unknown }; message?: unknown; name?: unknown }
    const message =
      (typeof obj.data?.message === "string" && obj.data.message) ||
      (typeof obj.message === "string" && obj.message) ||
      (typeof obj.name === "string" && obj.name) ||
      describeRequest(request, response)
    return new Error(message, { cause: { body: error, status: response?.status } })
  }

  return new Error(typeof error === "string" ? error : String(error), {
    cause: { body: error, status: response?.status },
  })
}

function describeRequest(request: Request | undefined, response: Response | undefined) {
  const method = request?.method ?? "?"
  const url = request?.url ?? "?"
  const statusText = response?.statusText ? " " + response.statusText : ""
  return `${method} ${url}${response ? " -> " + response.status : ""}${statusText}`
}

export function createOpencodeClient(config?: Config & { directory?: string; experimental_workspaceID?: string }) {
  if (!config?.fetch) {
    const customFetch: any = (req: any) => {
      // @ts-ignore
      req.timeout = false
      return fetch(req)
    }
    config = {
      ...config,
      fetch: customFetch,
    }
  }

  if (config?.directory) {
    config.headers = {
      ...config.headers,
      "x-opencode-directory": encodeURIComponent(config.directory),
    }
  }

  if (config?.experimental_workspaceID) {
    config.headers = {
      ...config.headers,
      "x-opencode-workspace": config.experimental_workspaceID,
    }
  }

  const client = createClient(config)
  client.interceptors.request.use((request) =>
    rewrite(request, {
      directory: config?.directory,
      workspace: config?.experimental_workspaceID,
    }),
  )
  client.interceptors.response.use((response) => {
    const contentType = response.headers.get("content-type")
    if (contentType === "text/html")
      throw new Error("Request is not supported by this version of OpenCode Server (Server responded with text/html)")

    return response
  })
  client.interceptors.error.use(wrapClientError)
  return new OpencodeClient({ client })
}
