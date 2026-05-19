import { createHash } from "node:crypto"
import type { MessageV2 } from "./message-v2"
import type { MessageID, SessionID } from "./schema"
import type { ToolFailureMetadata } from "./tool-failure"

export namespace SessionDiagnostics {
  const NON_SEMANTIC_KEYS = new Set(["requestid", "request_id", "traceid", "trace_id", "nonce"])

  export type ReminderType = "input_repeat" | "target_repeat" | "error_repeat"
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
  export type LoopOutcome = "success" | "failure"
  export type LoopAction = "observe" | "block" | "stop"
  export const LOOP_THRESHOLDS = {
    reminderAt: 3,
    blockAt: 4,
    stopAt: 5,
  } as const

  export type SignatureState = {
    outcome: LoopOutcome
    kind: SignatureKind
    completedCount: number
    outputHash?: string
    completedFailures?: number
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
    | {
        action: "block"
        sigKey: string
        outcome: LoopOutcome
        kind: SignatureKind
        completedCount: number
        completedFailures?: number
        nextOccurrenceCount: number
      }
    | {
        action: "stop"
        sigKey: string
        outcome: LoopOutcome
        kind: SignatureKind
        completedCount: number
        completedFailures?: number
        nextOccurrenceCount: number
      }

  export type LoopMetadata = {
    inputHash?: string
    inputRepeatCount?: number
    outputHash?: string
    targetSummary?: string
    targetHash?: string
    targetRepeatCount?: number
    newTarget?: boolean
    errorFingerprint?: string
    errorRepeatCount?: number
    outcome?: LoopOutcome
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
    loopCompletedCount?: number
    loopCompletedFailures?: number
    loopOccurrenceCount?: number
    loopSigKey?: string
    loopRecoverFiredFor?: string[]
    targetHashIsFallback?: boolean
    loopLastInput?: unknown
    loopLastError?: unknown
    attemptedInput?: unknown
    stepIndex?: number
  }

  export type Metadata = {
    diagnostics?: {
      loop?: LoopMetadata
      failure?: ToolFailureMetadata
    }
  }

  export type ToolCallRecord = {
    sessionID: SessionID
    parentID: MessageID
    tool: string
    inputHash: string
    targetHash: string
    outputHash?: string
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

  export function outputHash(output: unknown) {
    const value = normalizeValue(output)
    const serialized = JSON.stringify(value) ?? String(value)
    return hash(serialized)
  }

  export function signatureKey(input: {
    outcome: LoopOutcome
    kind: SignatureKind
    tool: string
    hash: string
  }) {
    return `${input.outcome}:${input.kind}:${input.tool}:${input.hash}`
  }

  const RENDERER_BYTE_LIMIT = 1024
  const DIAGNOSTIC_VALUE_BYTE_LIMIT = 4096

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

  export function compactDiagnosticValue(value: unknown): unknown {
    let s: string
    try {
      s = JSON.stringify(value) ?? String(value)
    } catch {
      s = String(value)
    }
    if (Buffer.byteLength(s, "utf8") <= DIAGNOSTIC_VALUE_BYTE_LIMIT) return value
    return {
      truncated: true,
      preview: truncateForRenderer(value),
    }
  }

  export function normalizeInput(input: unknown): { value: unknown; serialized: string; hash: string } {
    const value = normalizeValue(input)
    const serialized = JSON.stringify(value)
    return { value, serialized, hash: hash(serialized) }
  }

  export function targetSummary(tool: string, input: unknown): { summary: string; isFallback: boolean } {
    const target = findTarget(input)
    if (!target) return { summary: `${tool}:input:${normalizeInput(input).hash}`, isFallback: true }
    return { summary: `${target.kind}:${hash(target.value.trim())}`, isFallback: false }
  }

  // Coerce `unknown` to a single trimmed first line — used by errorFingerprint and the loop
  // renderer's stop-message extraction. Returns "" for nullish/empty.
  export function firstLine(value: unknown): string {
    if (value === undefined || value === null) return ""
    const message = typeof value === "string" ? value : value instanceof Error ? value.message : String(value)
    return (
      message
        .split(/\r?\n/)
        .map((item) => item.trim())
        .find(Boolean) ?? ""
    )
  }

  export function errorFingerprint(error: unknown) {
    const line = firstLine(error)
    const normalized = line
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
    const summaryResult = targetSummary(input.tool, input.input)
    const summary = summaryResult.summary
    const targetHash = hash(summary)
    const successfulRecords = input.records.filter((record) => {
      const loop = record.metadata.diagnostics?.loop
      return loop?.outcome !== "failure" && !loop?.errorFingerprint && !loop?.loopAction
    })
    const inputRepeatCount =
      successfulRecords.filter((record) => record.parentID === input.parentID && record.tool === input.tool && record.inputHash === normalized.hash).length + 1
    const targetRepeatCount =
      successfulRecords.filter(
        (record) =>
          record.parentID === input.parentID && record.tool === input.tool && record.targetHash === targetHash,
      ).length + 1
    const newReminders: Reminder[] = []
    const recoverFiredFor: string[] = []
    const inputSigKey = signatureKey({ outcome: "success", kind: "input", tool: input.tool, hash: normalized.hash })
    if (inputRepeatCount === LOOP_THRESHOLDS.reminderAt) {
      newReminders.push({
        key: inputSigKey,
        type: "input_repeat",
        status: "pending",
        count: inputRepeatCount,
        createdAt: Date.now(),
      })
      recoverFiredFor.push(inputSigKey)
    }
    if (!summaryResult.isFallback && targetRepeatCount === LOOP_THRESHOLDS.reminderAt) {
      const targetSigKey = signatureKey({ outcome: "success", kind: "target", tool: input.tool, hash: targetHash })
      newReminders.push({
        key: targetSigKey,
        type: "target_repeat",
        status: "pending",
        count: targetRepeatCount,
        createdAt: Date.now(),
      })
      recoverFiredFor.push(targetSigKey)
    }

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
            targetHashIsFallback: summaryResult.isFallback,
            targetRepeatCount,
            newTarget: targetRepeatCount === 1,
            outcome: "success",
            reminders: newReminders,
            loopRecoverFiredFor: recoverFiredFor.length ? recoverFiredFor : undefined,
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
    inputHash?: string
    targetHash?: string
    originalInput?: unknown
    error: unknown
  }) {
    const fingerprint = errorFingerprint(input.error)

    let effectiveInputHash = input.inputHash
    if (!effectiveInputHash && input.originalInput !== undefined) {
      effectiveInputHash = normalizeInput(input.originalInput).hash
    }

    // Recover targetHash symmetrically. If caller skipped both hashes (no inflight metadata)
    // but did provide originalInput, recompute target the same way observeToolCall would —
    // respecting `isFallback` so generic tools without a recognized target field still skip
    // target tracking. Without this, target_repeat / gate escalation silently degrades to
    // input-only tracking on the recovery path.
    let effectiveTargetHash = input.targetHash
    if (!effectiveTargetHash && input.originalInput !== undefined) {
      const target = targetSummary(input.tool, input.originalInput)
      if (!target.isFallback) effectiveTargetHash = hash(target.summary)
    }

    const lastInput = input.originalInput
    const lastError =
      typeof input.error === "string"
        ? input.error
        : input.error instanceof Error
          ? input.error.message
          : String(input.error)

    if (!effectiveInputHash) {
      const record: ToolErrorRecord = {
        sessionID: input.sessionID,
        parentID: input.parentID,
        tool: input.tool,
        inputHash: "",
        errorFingerprint: fingerprint,
        lastInput,
        lastError,
        metadata: {
          diagnostics: {
            loop: {
              errorFingerprint: fingerprint,
              outcome: "failure",
              reminders: [],
              loopLastInput: lastInput,
              loopLastError: lastError,
            },
          },
        },
      }
      return { record }
    }

    const real = input.records.filter(
      (r) =>
        r.parentID === input.parentID &&
        r.tool === input.tool &&
        r.metadata.diagnostics?.loop?.loopAction !== "block" &&
        r.metadata.diagnostics?.loop?.loopAction !== "stop",
    )

    const candidates: Array<{
      sigKey: string
      kind: SignatureKind
      matcher: (r: ToolErrorRecord) => boolean
    }> = []
    candidates.push({
      sigKey: signatureKey({ outcome: "failure", kind: "input", tool: input.tool, hash: effectiveInputHash }),
      kind: "input",
      matcher: (r) => r.inputHash === effectiveInputHash,
    })
    if (effectiveTargetHash) {
      const targetHash = effectiveTargetHash
      candidates.push({
        sigKey: signatureKey({ outcome: "failure", kind: "target", tool: input.tool, hash: targetHash }),
        kind: "target",
        matcher: (r) => r.targetHash === targetHash,
      })
    }

    const newReminders: Reminder[] = []
    const recoverFiredFor: string[] = []
    let maxCompletedFailures = 0
    for (const { sigKey, kind, matcher } of candidates) {
      const completedFailures = real.filter(matcher).length + 1
      maxCompletedFailures = Math.max(maxCompletedFailures, completedFailures)
      const alreadyFired = real.some((r) =>
        (r.metadata.diagnostics?.loop?.loopRecoverFiredFor ?? []).includes(sigKey),
      )
      if (completedFailures === LOOP_THRESHOLDS.reminderAt && !alreadyFired) {
        newReminders.push({
          key: sigKey,
          type: kind === "target" ? "target_repeat" : "input_repeat",
          status: "pending",
          count: completedFailures,
          createdAt: Date.now(),
        })
        recoverFiredFor.push(sigKey)
      }
    }

    const errorRepeatCount =
      real.filter((r) => r.errorFingerprint === fingerprint).length + 1

    const record: ToolErrorRecord = {
      sessionID: input.sessionID,
      parentID: input.parentID,
      tool: input.tool,
      inputHash: effectiveInputHash,
      targetHash: effectiveTargetHash,
      errorFingerprint: fingerprint,
      lastInput,
      lastError,
      metadata: {
        diagnostics: {
          loop: {
            outcome: "failure",
            errorFingerprint: fingerprint,
            errorRepeatCount,
            loopCompletedCount: maxCompletedFailures,
            reminders: newReminders,
            loopRecoverFiredFor: recoverFiredFor.length ? recoverFiredFor : undefined,
            loopLastInput: lastInput,
            loopLastError: lastError,
          },
        },
      },
    }
    return { record }
  }

  export function deriveParentLoopState(input: {
    errorRecords: ToolErrorRecord[]
    syntheticBlockSigKeys: string[]
    parentID: MessageID
    currentStepIndex?: number
  }): ParentLoopState {
    const signatures: Record<string, SignatureState> = {}

    const isFromPreviousStep = (record: { metadata: Metadata }) => {
      if (input.currentStepIndex === undefined) return true
      const stepIndex = record.metadata.diagnostics?.loop?.stepIndex
      return typeof stepIndex === "number" && stepIndex < input.currentStepIndex
    }

    const real = input.errorRecords.filter(
      (r) =>
        r.parentID === input.parentID &&
        r.metadata.diagnostics?.loop?.loopAction !== "block" &&
        r.metadata.diagnostics?.loop?.loopAction !== "stop" &&
        r.inputHash !== "" &&
        isFromPreviousStep(r),
    )

    for (const r of real) {
      const inputSigKey = r.inputHash ? signatureKey({ outcome: "failure", kind: "input", tool: r.tool, hash: r.inputHash }) : null
      const targetSigKey = r.targetHash ? signatureKey({ outcome: "failure", kind: "target", tool: r.tool, hash: r.targetHash }) : null
      const fired = r.metadata.diagnostics?.loop?.loopRecoverFiredFor ?? []
      for (const [sigKey, kind] of [
        [inputSigKey, "input"] as const,
        [targetSigKey, "target"] as const,
      ]) {
        if (!sigKey) continue
        const s = (signatures[sigKey] ??= {
          outcome: "failure",
          kind,
          completedCount: 0,
          completedFailures: 0,
          recoverEmitted: false,
          blockEmitted: false,
        })
        s.completedCount += 1
        s.completedFailures = (s.completedFailures ?? 0) + 1
        if (fired.includes(sigKey)) s.recoverEmitted = true
        if (r.lastInput !== undefined) s.lastInput = r.lastInput
        if (r.lastError !== undefined) s.lastError = r.lastError
      }
    }

    for (const sigKey of input.syntheticBlockSigKeys) {
      const parts = sigKey.split(":")
      const hasOutcome = parts[0] === "success" || parts[0] === "failure"
      const outcome: LoopOutcome = hasOutcome ? parts[0] as LoopOutcome : "failure"
      const kind: SignatureKind = (hasOutcome ? parts[1] : parts[0]) === "target" ? "target" : "input"
      const s = (signatures[sigKey] ??= {
        outcome,
        kind,
        completedCount: 0,
        completedFailures: outcome === "failure" ? 0 : undefined,
        recoverEmitted: false,
        blockEmitted: false,
      })
      s.blockEmitted = true
    }

    return {
      autoResumeSpent: input.syntheticBlockSigKeys.length > 0,
      signatures,
    }
  }

  export function queryGateAction(input: {
    parentLoopState: ParentLoopState
    tool: string
    inputHash: string
    targetHash?: string
    outcome?: LoopOutcome
  }): GateDecision {
    const { parentLoopState: state, tool, inputHash, targetHash } = input
    const outcome = input.outcome ?? "failure"
    // Success-side hard gate removed (#767). Snapshot patch parts (the mutation-epoch
    // signal source) silently disappear in real sessions, so successful TDD verify-edit
    // cycles look identical to a no-op loop and were getting hard-stopped. Reminders at
    // reminderAt still fire via observeToolCall; tool-layer protections handle stable-
    // success side-effecting tools (idempotency keys, permission prompts, rate limits).
    if (outcome === "success") return { action: "observe" }
    const inputKey = signatureKey({ outcome, kind: "input", tool, hash: inputHash })
    const targetKey = targetHash ? signatureKey({ outcome, kind: "target", tool, hash: targetHash }) : null

    const candidates = [targetKey, inputKey] as const
    for (const sigKey of candidates) {
      if (!sigKey) continue
      const s = state.signatures[sigKey]
      if (!s) continue
      if (s.completedCount >= LOOP_THRESHOLDS.reminderAt && s.recoverEmitted) {
        const nextOccurrenceCount = s.completedCount + (s.blockEmitted ? 2 : 1)
        if (nextOccurrenceCount >= LOOP_THRESHOLDS.stopAt && state.autoResumeSpent) {
          return {
            action: "stop",
            sigKey,
            outcome: s.outcome,
            kind: s.kind,
            completedCount: s.completedCount,
            completedFailures: s.completedFailures,
            nextOccurrenceCount,
          }
        }
        if (nextOccurrenceCount >= LOOP_THRESHOLDS.blockAt) {
          return {
            action: "block",
            sigKey,
            outcome: s.outcome,
            kind: s.kind,
            completedCount: s.completedCount,
            completedFailures: s.completedFailures,
            nextOccurrenceCount,
          }
        }
      }
    }

    return { action: "observe" }
  }

  export function chooseGateDecision(failureDecision: GateDecision, successDecision: GateDecision): GateDecision {
    if (failureDecision.action === "stop") return failureDecision
    if (successDecision.action === "stop") return successDecision
    if (failureDecision.action === "block") return failureDecision
    if (successDecision.action === "block") return successDecision
    return failureDecision
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
    const lines: string[] = ["<system-reminder>"]
    const parsed = pending.map((r) => parseReminderKey(r.key))
    const sawSuccessInput = parsed.some((r) => r.outcome === "success" && r.kind === "input")
    const sawSuccessTarget = parsed.some((r) => r.outcome === "success" && r.kind === "target")
    const sawFailureInput = parsed.some((r) => (r.outcome === "failure" || r.legacy) && r.kind === "input")
    const sawFailureTarget = parsed.some((r) => (r.outcome === "failure" || r.legacy) && r.kind === "target")
    // Backward-compat: v0 reminders persisted with `error:` (or other) prefixes. Without this
    // fallback they get silently consumed (status flipped to "injected") with no model-facing
    // text, which loses the warning entirely. Emit the legacy generic copy so old sessions still
    // surface a reminder during migration.
    const sawLegacy = parsed.some((r) => r.legacy && !r.kind)
    if (sawSuccessInput) {
      lines.push(
        "You are repeating the same tool request. Change strategy: summarize what you already learned, choose a different target or method, or answer the user directly. Do not repeat the same request in this turn.",
      )
    }
    if (sawSuccessTarget) {
      lines.push(
        "You are looking at the same target again. Summarize what you already learned; if you continue, use a new range, query, or hypothesis.",
      )
    }
    if (sawFailureInput) {
      lines.push(
        "Detected that you have repeated the same tool input 3 times. Do not call the same input again. Reuse the existing result, change strategy, or summarize the current blocker.",
      )
    }
    if (sawFailureTarget) {
      lines.push(
        "Detected that you have failed against the same target multiple times even though the errors differ. Do not keep retrying. Change approach, identify why the target is unreachable, or summarize the current blocker.",
      )
    }
    if (sawLegacy && !sawFailureInput && !sawFailureTarget) {
      lines.push(
        "Detected that you have hit the same class of tool error multiple times. Do not keep retrying blindly. Identify the failure layer, change strategy, or summarize the current blocker.",
      )
    }
    lines.push("</system-reminder>")
    return { text: lines.join("\n"), parts }
  }

  function parseReminderKey(key: string): { outcome?: LoopOutcome; kind?: SignatureKind; legacy: boolean } {
    const parts = key.split(":")
    if (parts[0] === "success" || parts[0] === "failure") {
      const kind = parts[1] === "target" ? "target" : parts[1] === "input" ? "input" : undefined
      return { outcome: parts[0], kind, legacy: false }
    }
    if (parts[0] === "input" || parts[0] === "target") return { kind: parts[0], legacy: true }
    return { legacy: true }
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
    // Blank/whitespace strings would hash to a stable target across unrelated tool calls and
    // poison same_target accumulation. Treat them as "no target" so loop detection skips
    // target tracking instead of locking onto an empty signature.
    for (const key of ["url", "href"]) {
      const raw = record[key]
      if (typeof raw === "string" && raw.trim().length > 0) return { kind: "url", value: raw }
    }
    for (const key of ["query", "search", "pattern", "path", "filePath", "filepath", "command", "cmd"]) {
      const raw = record[key]
      if (typeof raw === "string" && raw.trim().length > 0) {
        return { kind: key === "filePath" || key === "filepath" ? "path" : key, value: raw }
      }
    }
    return undefined
  }

  function toolFamily(tool: string) {
    const [family] = tool.split(/[.:_/]/)
    return family || tool
  }
}
