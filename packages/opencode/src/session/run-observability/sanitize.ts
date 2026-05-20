import { isRecord } from "@/util/record"
import type { SafeErrorFingerprint, SafeToolName, ToolEffect } from "./types"

export function safeToolName(value: unknown): SafeToolName {
  if (typeof value !== "string") return "unknown" as SafeToolName
  const trimmed = value.trim().slice(0, 80)
  if (!trimmed) return "unknown" as SafeToolName
  if (/https?:\/\//i.test(trimmed) || /[/\\?]/.test(trimmed) || /token|secret|bearer|sk-|cookie/i.test(trimmed)) {
    return "redacted" as SafeToolName
  }
  const safe = trimmed.replace(/[^a-zA-Z0-9_.:-]/g, "_")
  return (safe || "unknown") as SafeToolName
}

export function toolEffect(toolName: string): ToolEffect {
  if (toolName === "read" || toolName === "glob" || toolName === "grep" || toolName === "webfetch") {
    return { kind: "read_only", unsafe: false, complete: true }
  }
  if (toolName === "apply_patch") return { kind: "local_file_write", unsafe: true, complete: true }
  if (toolName === "bash") return { kind: "local_process", unsafe: true, complete: true }
  return { kind: "unknown", unsafe: true, complete: false }
}

export function safeErrorFingerprint(error: unknown): SafeErrorFingerprint {
  const record = isRecord(error) ? error : undefined
  const cause = record && isRecord(record.cause) ? record.cause : undefined
  return compact({
    name: safeLowCardinality(record?.name ?? record?.constructor?.name),
    message: safeErrorMessage(record?.message ?? (typeof error === "string" ? error : undefined)),
    code: safeLowCardinality(record?.code),
    cause_name: safeLowCardinality(cause?.name ?? cause?.constructor?.name),
    cause_message: safeErrorMessage(cause?.message),
    cause_code: safeLowCardinality(cause?.code),
  })
}

function safeLowCardinality(value: unknown) {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 80) return undefined
  if (!/^[a-zA-Z0-9_.:-]+$/.test(trimmed)) return undefined
  return trimmed
}

function safeErrorMessage(value: unknown) {
  if (typeof value !== "string") return undefined
  const normalized = value.trim().toLowerCase()
  if (!normalized) return undefined
  if (normalized === "terminated") return "terminated"
  if (normalized === "aborted") return "aborted"
  if (normalized === "other side closed") return "other side closed"
  if (normalized.includes("tool execution aborted")) return "tool execution aborted"
  if (normalized.includes("socket") && normalized.includes("closed")) return "socket closed"
  if (normalized.includes("timeout") || normalized.includes("timed out")) return "timeout"
  if (normalized.includes("rate limit")) return "rate_limit"
  if (normalized.includes("unauthorized") || normalized.includes("forbidden")) return "auth_failure"
  return "redacted"
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T
}
