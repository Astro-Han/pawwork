import { createHash } from "node:crypto"
import type { MessageV2 } from "./message-v2"
import type { MessageID, SessionID } from "./schema"

export namespace SessionDiagnostics {
  const NON_SEMANTIC_KEYS = new Set(["requestid", "request_id", "traceid", "trace_id", "nonce"])

  export type ReminderType = "input_repeat" | "error_repeat"
  export type ReminderStatus = "pending" | "injected"

  export type Reminder = {
    key: string
    type: ReminderType
    status: ReminderStatus
    count: number
    createdAt: number
    injectedAt?: number
  }

  export type SignatureKind = "input" | "target"
  export type LoopAction = "observe" | "block" | "stop"

  export type SignatureState = {
    kind: SignatureKind
    completedFailures: number
    recoverEmitted: boolean
    blockEmitted: boolean
    lastInput?: unknown
    lastError?: unknown
  }

  export type ParentLoopState = {
    autoResumeSpent: boolean
    signatures: Record<string, SignatureState>
  }

  export type GateDecision =
    | { action: "observe" }
    | { action: "block"; sigKey: string; kind: SignatureKind; completedFailures: number }
    | { action: "stop"; sigKey: string; kind: SignatureKind; completedFailures: number }

  export type LoopMetadata = {
    inputHash?: string
    inputRepeatCount?: number
    targetSummary?: string
    targetHash?: string
    targetRepeatCount?: number
    newTarget?: boolean
    errorFingerprint?: string
    errorRepeatCount?: number
    reminders?: Reminder[]
    modelID?: string
    providerID?: string
    agent?: string
    sessionID?: SessionID
    parentSessionID?: SessionID
    isSubagent?: boolean
    parentID?: MessageID
    toolFamily?: string
    truncated?: boolean
    loopAction?: LoopAction
    loopType?: SignatureKind
    loopCompletedFailures?: number
    loopSigKey?: string
    loopRecoverFiredFor?: string[]
    targetHashIsFallback?: boolean
    loopLastInput?: unknown
    loopLastError?: unknown
  }

  export type Metadata = {
    diagnostics?: {
      loop?: LoopMetadata
    }
  }

  export type ToolCallRecord = {
    sessionID: SessionID
    parentID: MessageID
    tool: string
    inputHash: string
    targetHash: string
    metadata: Metadata
  }

  export type ToolErrorRecord = {
    sessionID: SessionID
    parentID: MessageID
    tool: string
    inputHash: string
    targetHash?: string
    errorFingerprint: string
    lastInput?: unknown
    lastError?: unknown
    metadata: Metadata
  }

  export function hash(value: string) {
    return createHash("sha256").update(value).digest("hex").slice(0, 16)
  }

  const RENDERER_BYTE_LIMIT = 1024

  export function truncateForRenderer(value: unknown): string {
    let s: string
    if (typeof value === "string") s = value
    else {
      try {
        s = JSON.stringify(value) ?? String(value)
      } catch {
        // BigInt, circular, or other non-serializable payloads fall back to String coercion.
        s = String(value)
      }
    }
    const buf = Buffer.from(s, "utf8")
    if (buf.byteLength <= RENDERER_BYTE_LIMIT) return s
    let cutByte = RENDERER_BYTE_LIMIT
    while (cutByte > 0) {
      const slice = buf.subarray(0, cutByte).toString("utf8")
      if (slice.charCodeAt(slice.length - 1) === 0xfffd) {
        cutByte -= 1
        continue
      }
      if (slice.endsWith("%") || /%[0-9A-Fa-f]$/.test(slice)) {
        cutByte -= 1
        continue
      }
      return slice + "…"
    }
    return "…"
  }

  export function normalizeInput(input: unknown): { value: unknown; serialized: string; hash: string } {
    const value = normalizeValue(input)
    const serialized = JSON.stringify(value)
    return { value, serialized, hash: hash(serialized) }
  }

  export function targetSummary(tool: string, input: unknown) {
    const target = findTarget(input)
    if (!target) return `${tool}:input:${normalizeInput(input).hash}`
    return `${target.kind}:${hash(target.value.trim())}`
  }

  export function errorFingerprint(error: unknown) {
    const message = typeof error === "string" ? error : error instanceof Error ? error.message : String(error)
    const line = message
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find(Boolean)
    const normalized = (line ?? "")
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, "<url>")
      .replace(/['"`][^'"`]*['"`]/g, "<quoted>")
      .replace(/[A-Za-z]:\\[^\s]+/g, "<path>")
      .replace(/\/[^\s,;)]+/g, "<path>")
      .replace(/\b[0-9a-f]{7,}\b/g, "<id>")
      .replace(/\b\d+\b/g, "<num>")
      .replace(/\s+/g, " ")
      .trim()
    return hash(normalized)
  }

  export function observeToolCall(input: {
    records: ToolCallRecord[]
    sessionID: SessionID
    parentID: MessageID
    parentSessionID?: SessionID
    tool: string
    input: unknown
    agent: string
    modelID: string
    providerID: string
  }) {
    const normalized = normalizeInput(input.input)
    const summary = targetSummary(input.tool, input.input)
    const targetHash = hash(summary)
    const inputKey = `input:${input.parentID}:${input.tool}:${normalized.hash}`
    const inputRepeatCount =
      input.records.filter((record) => record.parentID === input.parentID && record.tool === input.tool && record.inputHash === normalized.hash).length + 1
    const targetRepeatCount =
      input.records.filter((record) => record.parentID === input.parentID && record.targetHash === targetHash).length + 1
    const hasReminder = input.records.some((record) =>
      record.metadata.diagnostics?.loop?.reminders?.some((reminder) => reminder.key === inputKey),
    )
    const reminders =
      inputRepeatCount === 3 && !hasReminder
        ? [
            {
              key: inputKey,
              type: "input_repeat" as const,
              status: "pending" as const,
              count: inputRepeatCount,
              createdAt: Date.now(),
            },
          ]
        : []

    const record: ToolCallRecord = {
      sessionID: input.sessionID,
      parentID: input.parentID,
      tool: input.tool,
      inputHash: normalized.hash,
      targetHash,
      metadata: {
        diagnostics: {
          loop: {
            inputHash: normalized.hash,
            inputRepeatCount,
            targetSummary: summary,
            targetHash,
            targetRepeatCount,
            newTarget: targetRepeatCount === 1,
            reminders,
            modelID: input.modelID,
            providerID: input.providerID,
            agent: input.agent,
            sessionID: input.sessionID,
            parentSessionID: input.parentSessionID,
            isSubagent: input.parentSessionID !== undefined,
            parentID: input.parentID,
            toolFamily: toolFamily(input.tool),
          },
        },
      },
    }
    return { record }
  }

  export function observeToolError(input: {
    records: ToolErrorRecord[]
    sessionID: SessionID
    parentID: MessageID
    tool: string
    error: unknown
  }) {
    const fingerprint = errorFingerprint(input.error)
    const key = `error:${input.parentID}:${input.tool}:${fingerprint}`
    const errorRepeatCount =
      input.records.filter(
        (record) =>
          record.parentID === input.parentID && record.tool === input.tool && record.errorFingerprint === fingerprint,
      ).length + 1
    const hasReminder = input.records.some((record) =>
      record.metadata.diagnostics?.loop?.reminders?.some((reminder) => reminder.key === key),
    )
    const reminders =
      errorRepeatCount === 3 && !hasReminder
        ? [
            {
              key,
              type: "error_repeat" as const,
              status: "pending" as const,
              count: errorRepeatCount,
              createdAt: Date.now(),
            },
          ]
        : []
    const record: ToolErrorRecord = {
      sessionID: input.sessionID,
      parentID: input.parentID,
      tool: input.tool,
      inputHash: "",
      errorFingerprint: fingerprint,
      metadata: {
        diagnostics: {
          loop: {
            errorFingerprint: fingerprint,
            errorRepeatCount,
            reminders,
          },
        },
      },
    }
    return { record }
  }

  export function mergeMetadata<T extends Record<string, any> | undefined>(current: T, update: Metadata): NonNullable<T> & Metadata {
    if (!current?.diagnostics && !update.diagnostics) {
      return { ...(current ?? {}), ...update } as NonNullable<T> & Metadata
    }

    return {
      ...(current ?? {}),
      ...update,
      diagnostics: {
        ...(current?.diagnostics ?? {}),
        ...(update.diagnostics ?? {}),
        loop: {
          ...(current?.diagnostics?.loop ?? {}),
          ...(update.diagnostics?.loop ?? {}),
        },
      },
    } as NonNullable<T> & Metadata
  }

  export function consumeReminders(input: {
    messages: MessageV2.WithParts[]
    parentID: MessageID
    now?: number
  }): { text?: string; parts: MessageV2.ToolPart[] } {
    const now = input.now ?? Date.now()
    const pending: Reminder[] = []
    const parts: MessageV2.ToolPart[] = []

    for (const message of input.messages) {
      if (message.info.role !== "assistant" || message.info.parentID !== input.parentID) continue
      for (const part of message.parts) {
        if (part.type !== "tool") continue
        const metadata = "metadata" in part.state ? part.state.metadata : undefined
        const reminders = metadata?.diagnostics?.loop?.reminders
        if (!Array.isArray(reminders)) continue
        let changed = false
        const nextReminders = reminders.map((reminder: Reminder) => {
          if (reminder.status !== "pending") return reminder
          changed = true
          pending.push(reminder)
          return { ...reminder, status: "injected" as const, injectedAt: now }
        })
        if (!changed) continue
        parts.push({
          ...part,
          state: {
            ...part.state,
            metadata: mergeMetadata(metadata, {
              diagnostics: {
                loop: {
                  reminders: nextReminders,
                },
              },
            }),
          } as MessageV2.ToolPart["state"],
        })
      }
    }

    if (!pending.length) return { parts }
    const hasInputRepeat = pending.some((reminder) => reminder.type === "input_repeat")
    const hasErrorRepeat = pending.some((reminder) => reminder.type === "error_repeat")
    const lines = ["<system-reminder>"]
    if (hasInputRepeat) {
      lines.push(
        "Detected that you have repeated the same tool input 3 times. Do not call the same input again. Reuse the existing result, change strategy, or summarize the current blocker.",
      )
    }
    if (hasErrorRepeat) {
      lines.push(
        "Detected that you have hit the same class of tool error multiple times. Do not keep retrying blindly. Identify the failure layer, change strategy, or summarize the current blocker.",
      )
    }
    lines.push("</system-reminder>")
    return { text: lines.join("\n"), parts }
  }

  function normalizeValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(normalizeValue)
    if (!value || typeof value !== "object") return typeof value === "string" ? value.trim() : value

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !NON_SEMANTIC_KEYS.has(key.toLowerCase()))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, normalizeValue(item)]),
    )
  }

  function findTarget(input: unknown): { kind: string; value: string } | undefined {
    if (!input || typeof input !== "object") return undefined
    const record = input as Record<string, unknown>
    for (const key of ["url", "href"]) {
      if (typeof record[key] === "string") return { kind: "url", value: record[key] }
    }
    for (const key of ["query", "search", "pattern", "path", "command", "cmd"]) {
      if (typeof record[key] === "string") return { kind: key, value: record[key] }
    }
    return undefined
  }

  function toolFamily(tool: string) {
    const [family] = tool.split(/[.:_/]/)
    return family || tool
  }
}
