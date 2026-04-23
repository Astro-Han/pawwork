import type { RendererErrorDetails, ReportProblemResult } from "@/context/platform"
import { ChildStoreError } from "@/context/global-sync/child-store-error"

export type InitError = {
  name: string
  data: Record<string, unknown>
}

export type ErrorReportTranslator = (key: string, vars?: Record<string, string | number | boolean>) => string
const CHAIN_SEPARATOR = "\n" + "─".repeat(40) + "\n"

type ErrorLike = {
  name?: unknown
  message?: unknown
  stack?: unknown
  cause?: unknown
}

function isIssue(value: unknown): value is { message: string; path: string[] } {
  if (!value || typeof value !== "object") return false
  if (!("message" in value) || !("path" in value)) return false
  const message = (value as { message: unknown }).message
  const path = (value as { path: unknown }).path
  if (typeof message !== "string") return false
  if (!Array.isArray(path)) return false
  return path.every((part) => typeof part === "string")
}

function isInitError(error: unknown): error is InitError {
  const name =
    typeof error === "object" && error !== null && "name" in error ? (error as { name: unknown }).name : undefined
  const data =
    typeof error === "object" && error !== null && "data" in error ? (error as { data: unknown }).data : undefined
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    "data" in error &&
    typeof name === "string" &&
    typeof data === "object" &&
    data !== null &&
    !Array.isArray(data)
  )
}

function isErrorLike(error: unknown): error is ErrorLike {
  if (error instanceof Error) return true
  if (!error || typeof error !== "object") return false
  const candidate = error as ErrorLike
  return typeof candidate.message === "string" && typeof candidate.stack === "string"
}

function safeJson(value: unknown, circular: string): string {
  const seen = new WeakSet<object>()
  const json = JSON.stringify(
    value,
    (_key, val) => {
      if (typeof val === "bigint") return val.toString()
      if (typeof val === "object" && val) {
        if (seen.has(val)) return circular
        seen.add(val)
      }
      return val
    },
    2,
  )
  return json ?? String(value)
}

function formatInitError(error: InitError, t: ErrorReportTranslator): string {
  const data = error.data
  const json = (value: unknown) => safeJson(value, t("error.page.circular"))
  switch (error.name) {
    case "MCPFailed": {
      const name = typeof data.name === "string" ? data.name : ""
      return t("error.chain.mcpFailed", { name })
    }
    case "ProviderAuthError": {
      const providerID = typeof data.providerID === "string" ? data.providerID : t("common.unknown")
      const message = typeof data.message === "string" ? data.message : json(data.message)
      return t("error.chain.providerAuthFailed", { provider: providerID, message })
    }
    case "APIError": {
      const message = typeof data.message === "string" ? data.message : t("error.chain.apiError")
      const lines: string[] = [message]

      if (typeof data.statusCode === "number") {
        lines.push(t("error.chain.status", { status: data.statusCode }))
      }

      if (typeof data.isRetryable === "boolean") {
        lines.push(t("error.chain.retryable", { retryable: data.isRetryable }))
      }

      if (typeof data.responseBody === "string" && data.responseBody) {
        lines.push(t("error.chain.responseBody", { body: data.responseBody }))
      }

      return lines.join("\n")
    }
    case "ProviderModelNotFoundError": {
      const { providerID, modelID, suggestions } = data as {
        providerID: string
        modelID: string
        suggestions?: string[]
      }

      const suggestionsLine =
        Array.isArray(suggestions) && suggestions.length
          ? [t("error.chain.didYouMean", { suggestions: suggestions.join(", ") })]
          : []

      return [
        t("error.chain.modelNotFound", { provider: providerID, model: modelID }),
        ...suggestionsLine,
        t("error.chain.checkConfig"),
      ].join("\n")
    }
    case "ProviderInitError": {
      const providerID = typeof data.providerID === "string" ? data.providerID : t("common.unknown")
      return t("error.chain.providerInitFailed", { provider: providerID })
    }
    case "ConfigJsonError": {
      const path = typeof data.path === "string" ? data.path : json(data.path)
      const message = typeof data.message === "string" ? data.message : ""
      if (message) return t("error.chain.configJsonInvalidWithMessage", { path, message })
      return t("error.chain.configJsonInvalid", { path })
    }
    case "ConfigDirectoryTypoError": {
      const path = typeof data.path === "string" ? data.path : json(data.path)
      const dir = typeof data.dir === "string" ? data.dir : json(data.dir)
      const suggestion = typeof data.suggestion === "string" ? data.suggestion : json(data.suggestion)
      return t("error.chain.configDirectoryTypo", { dir, path, suggestion })
    }
    case "ConfigFrontmatterError": {
      const path = typeof data.path === "string" ? data.path : json(data.path)
      const message = typeof data.message === "string" ? data.message : json(data.message)
      return t("error.chain.configFrontmatterError", { path, message })
    }
    case "ConfigInvalidError": {
      const issues = Array.isArray(data.issues)
        ? data.issues.filter(isIssue).map((issue) => "↳ " + issue.message + " " + issue.path.join("."))
        : []
      const message = typeof data.message === "string" ? data.message : ""
      const path = typeof data.path === "string" ? data.path : json(data.path)

      const line = message
        ? t("error.chain.configInvalidWithMessage", { path, message })
        : t("error.chain.configInvalid", { path })

      return [line, ...issues].join("\n")
    }
    case "UnknownError":
      return typeof data.message === "string" ? data.message : json(data)
    default:
      if (typeof data.message === "string") return data.message
      return json(data)
  }
}

function formatErrorChain(
  error: unknown,
  t: ErrorReportTranslator,
  depth = 0,
  parentMessage?: string,
  seen = new WeakSet<object>(),
): string {
  const json = (value: unknown) => safeJson(value, t("error.page.circular"))
  if (!error) return t("error.chain.unknown")
  const indent = depth > 0 ? `\n${CHAIN_SEPARATOR}${t("error.chain.causedBy")}\n` : ""

  if (typeof error === "object" && error !== null) {
    if (seen.has(error)) return indent + t("error.page.circular")
    seen.add(error)
  }

  if (isInitError(error)) {
    const message = formatInitError(error, t)
    if (depth > 0 && parentMessage === message) return ""
    return indent + `${error.name}\n${message}`
  }

  if (isErrorLike(error)) {
    const message = typeof error.message === "string" ? error.message : ""
    const name = typeof error.name === "string" && error.name ? error.name : "Error"
    const isDuplicate = depth > 0 && parentMessage === message
    const parts: string[] = []

    const header = `${name}${message ? `: ${message}` : ""}`
    const stack = typeof error.stack === "string" ? error.stack.trim() : undefined

    if (stack) {
      const startsWithHeader = stack.startsWith(header)

      if (isDuplicate && startsWithHeader) {
        const trace = stack.split("\n").slice(1).join("\n").trim()
        if (trace) {
          parts.push(indent + trace)
        }
      }

      if (isDuplicate && !startsWithHeader) {
        parts.push(indent + stack)
      }

      if (!isDuplicate && startsWithHeader) {
        parts.push(indent + stack)
      }

      if (!isDuplicate && !startsWithHeader) {
        parts.push(indent + `${header}\n${stack}`)
      }
    }

    if (!stack && !isDuplicate) {
      parts.push(indent + header)
    }

    if (error instanceof ChildStoreError) {
      parts.push(indent + `Context\n${json(error.context)}`)
    }

    if (error.cause) {
      const causeResult = formatErrorChain(error.cause, t, depth + 1, message, seen)
      if (causeResult) {
        parts.push(causeResult)
      }
    }

    return parts.join("\n\n")
  }

  if (typeof error === "string") {
    if (depth > 0 && parentMessage === error) return ""
    return indent + error
  }

  return indent + json(error)
}

export function formatError(error: unknown, t: ErrorReportTranslator): string {
  return formatErrorChain(error, t, 0)
}

export function summarizeKnownError(error: unknown, t: ErrorReportTranslator) {
  if (error instanceof ChildStoreError) {
    return {
      title: t("error.page.known.localState.title"),
      description: t("error.page.known.localState.description"),
    }
  }
}

export function buildErrorReportDetails(error: unknown, t: ErrorReportTranslator): RendererErrorDetails {
  const known = summarizeKnownError(error, t)
  const summary =
    known?.description ??
    (isErrorLike(error) && typeof error.message === "string" ? error.message : formatError(error, t).split(/\r?\n/)[0])
  return {
    summary,
    details: formatError(error, t),
  }
}

export function errorReportStatusMessage(result: ReportProblemResult, t: ErrorReportTranslator) {
  if (result.status === "ready") return t("error.page.report.success")
  if (result.status === "summary-only") return t("error.page.report.summaryOnly")
  if (result.status === "form-fallback") return t("error.page.report.formFallback", { url: result.feedbackUrl })
  if (result.status === "cancelled") return undefined
  if (result.status === "unavailable") return t("error.page.report.unavailable")
  return t("error.page.report.failed")
}
