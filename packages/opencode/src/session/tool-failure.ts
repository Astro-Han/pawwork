import { Permission } from "@/permission"

export const TOOL_FAILURE_KINDS = [
  "invalid_arguments",
  "permission_denied",
  "environment",
  "provider",
  "timeout",
  "user_aborted",
  "unknown",
] as const

export type ToolFailureKind = (typeof TOOL_FAILURE_KINDS)[number]

export const TOOL_FAILURE_HINTS: Record<ToolFailureKind, string> = {
  invalid_arguments: "Fix the tool arguments to match the schema before retrying.",
  permission_denied: "Do not retry the same blocked call; ask the user or choose an allowed safer action.",
  environment: "Check the path, working directory, command availability, or local setup before retrying.",
  provider: "Treat this as an external provider or API failure; retry later or report the provider issue.",
  timeout: "Narrow the operation or increase the timeout only when appropriate.",
  user_aborted: "Stop this action; do not continue canceled work unless the user asks.",
  unknown: "Identify the failure layer before retrying.",
}

export type ToolFailureMetadata = {
  errorKind: ToolFailureKind
  recoveryHint: string
}

const KIND_SET = new Set<ToolFailureKind>(TOOL_FAILURE_KINDS)

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function stringField(value: unknown, key: string) {
  const obj = object(value)
  const field = obj?.[key]
  return typeof field === "string" ? field : undefined
}

function numberField(value: unknown, key: string) {
  const obj = object(value)
  const field = obj?.[key]
  return typeof field === "number" ? field : undefined
}

function booleanField(value: unknown, key: string) {
  const obj = object(value)
  const field = obj?.[key]
  return typeof field === "boolean" ? field : undefined
}

function text(error: unknown) {
  const parts = [
    stringField(error, "name"),
    stringField(error, "_tag"),
    stringField(error, "code"),
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error),
  ].filter(Boolean)
  return parts.join(" ").toLowerCase()
}

function hasAny(value: string, patterns: readonly string[]) {
  return patterns.some((pattern) => value.includes(pattern))
}

function canonical(errorKind: ToolFailureKind): ToolFailureMetadata {
  return {
    errorKind,
    recoveryHint: TOOL_FAILURE_HINTS[errorKind],
  }
}

function isToolFailureKind(value: unknown): value is ToolFailureKind {
  return typeof value === "string" && KIND_SET.has(value as ToolFailureKind)
}

export function classifyToolFailure(input: { tool: string; error: unknown }): ToolFailureMetadata {
  const error = input.error
  const code = stringField(error, "code")?.toUpperCase()
  const name = stringField(error, "name")
  const tag = stringField(error, "_tag")
  const value = text(error)

  if (
    error instanceof Permission.RejectedError ||
    error instanceof Permission.CorrectedError ||
    error instanceof Permission.DeniedError ||
    code === "EACCES" ||
    code === "EPERM"
  ) {
    return canonical("permission_denied")
  }

  if (
    hasAny(value, [
      "invalid arguments",
      "invalid argument",
      "malformed tool input",
      "expected schema",
      "satisfies the expected schema",
      "schema decode",
      "invalid timeout",
      "invalid value",
    ])
  ) {
    return canonical("invalid_arguments")
  }

  if (
    name === "AbortError" ||
    code === "ABORT_ERR" ||
    hasAny(value, ["user aborted", "user cancelled", "user canceled", "cancelled before", "canceled before"])
  ) {
    return canonical("user_aborted")
  }

  if (name === "TimeoutError" || code === "ETIMEDOUT" || hasAny(value, ["timed out", "timeout", "exceeded timeout"])) {
    return canonical("timeout")
  }

  if (
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    hasAny(value, [
      "no such file or directory",
      "file not found",
      "directory not found",
      "command not found",
      "working directory",
      "missing cwd",
      "missing path",
      "path does not exist",
      "not a directory",
    ])
  ) {
    return canonical("environment")
  }

  if (
    tag === "APICallError" ||
    name === "APICallError" ||
    numberField(error, "statusCode") !== undefined ||
    booleanField(error, "isRetryable") !== undefined ||
    hasAny(value, [
      "api key",
      "api call",
      "api error",
      "provider",
      "rate limit",
      "quota",
      "unauthorized",
      "authentication",
      "service unavailable",
      "overloaded",
    ])
  ) {
    return canonical("provider")
  }

  return canonical("unknown")
}

export function safeToolFailureMetadata(value: unknown): ToolFailureMetadata | undefined {
  const failure = object(value)
  const errorKind = typeof failure?.errorKind === "string" ? failure.errorKind : undefined
  if (!isToolFailureKind(errorKind)) return undefined
  return canonical(errorKind)
}

export function formatToolFailureForModel(errorText: string, failure?: ToolFailureMetadata) {
  const safeFailure = safeToolFailureMetadata(failure)
  if (!safeFailure) return errorText
  return `${errorText}\n\nTool failure reason: ${safeFailure.errorKind}. Recovery hint: ${safeFailure.recoveryHint}`
}
