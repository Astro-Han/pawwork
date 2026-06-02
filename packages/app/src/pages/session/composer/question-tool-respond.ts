import { createStore } from "solid-js/store"

type NormalizedToolRespondError =
  | { type: "already_resolved"; requestID?: string }
  | { type: "stale_session" }
  | { type: "invalid_payload"; detail?: string }
  | { type: "unknown"; detail?: string }

type QuestionResponsePhase = "idle" | "submitting" | "closing"

const invalidPayloadErrorCodes = new Set(["answer_count_mismatch"])

export function createQuestionResponseGuard(initialRequestID: string) {
  const [state, setState] = createStore<{ requestID: string; phase: QuestionResponsePhase }>({
    requestID: initialRequestID,
    phase: "idle",
  })

  const sync = (nextRequestID: string) => {
    if (nextRequestID === state.requestID) return
    setState({ requestID: nextRequestID, phase: "idle" })
  }

  return {
    canInteract(nextRequestID: string) {
      sync(nextRequestID)
      return state.phase === "idle"
    },
    begin(nextRequestID: string) {
      sync(nextRequestID)
      if (state.phase !== "idle") return false
      setState("phase", "submitting")
      return true
    },
    confirm(nextRequestID: string) {
      sync(nextRequestID)
      if (state.phase === "submitting") setState("phase", "closing")
    },
    fail(nextRequestID: string) {
      sync(nextRequestID)
      setState("phase", "idle")
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined
}

function statusFromToolRespondError(err: unknown): number | undefined {
  if (!isRecord(err)) return undefined
  const response = err.response
  if (isRecord(response) && typeof response.status === "number") return response.status
  if (typeof err.status === "number") return err.status
  if (typeof err.statusCode === "number") return err.statusCode
  return undefined
}

function errorCodeFromToolRespondError(err: unknown): string | undefined {
  if (!isRecord(err)) return undefined
  const bodyError = err.error
  if (typeof bodyError === "string") return bodyError
  if (isRecord(bodyError)) return stringField(bodyError.error)
  return undefined
}

function detailsFromToolRespondError(err: unknown): string | undefined {
  if (!isRecord(err)) return undefined
  const details = err.details
  if (typeof details === "string") return details
  if (isRecord(details)) {
    try {
      return JSON.stringify(details)
    } catch {
      return undefined
    }
  }
  return undefined
}

function requestIDFromToolRespondError(err: unknown): string | undefined {
  if (!isRecord(err)) return undefined
  const request = err.request
  if (isRecord(request)) return stringField(request.id)
  return undefined
}

export function normalizeToolRespondError(err: unknown): NormalizedToolRespondError {
  const status = statusFromToolRespondError(err)
  const code = errorCodeFromToolRespondError(err)
  const details = detailsFromToolRespondError(err)

  if (code === "already_resolved") return { type: "already_resolved", requestID: requestIDFromToolRespondError(err) }
  if (code === "no_pending_tool_call") return { type: "stale_session" }
  if (status === 404) return { type: "stale_session" }
  if (status === 409) return { type: "already_resolved", requestID: requestIDFromToolRespondError(err) }
  if (status === 400 || status === 422 || invalidPayloadErrorCodes.has(code ?? "") || details !== undefined) {
    const detail = [code, details].filter(Boolean).join(" ")
    return { type: "invalid_payload", detail: detail || undefined }
  }
  if (err instanceof Error) return { type: "unknown", detail: err.message }
  if (typeof err === "string") return { type: "unknown", detail: err }
  if (code) return { type: "unknown", detail: code }
  return { type: "unknown" }
}

/**
 * After skipping a question (setting its answer to []), decide the next action.
 * Returns either the tab to navigate to, or a submit signal when all questions are settled.
 */
export function resolveSkipAction(
  currentTab: number,
  isSettled: (i: number) => boolean,
  total: number,
): { type: "navigate"; tab: number } | { type: "submit" } {
  // First, look for an unsettled question after the current tab.
  for (let i = currentTab + 1; i < total; i++) {
    if (!isSettled(i)) return { type: "navigate", tab: i }
  }
  // Then, look for any unsettled question before the current tab.
  for (let i = 0; i < currentTab; i++) {
    if (!isSettled(i)) return { type: "navigate", tab: i }
  }
  // All settled — time to submit.
  return { type: "submit" }
}
