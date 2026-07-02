import type {
  PendingPermission,
  PendingQuestion,
  PermissionResolution,
  Question,
  QuestionResolution,
  Session,
} from "./types.ts"

/**
 * Consumes PawWork's global SSE stream. The six required methods receive
 * actionable state; the three optional hooks let a handler reconcile via the
 * REST list endpoints on (re)connect or after a skipped event. Ported from the
 * Go `pawwork.EventHandler` + its optional companion interfaces.
 */
export interface EventHandler {
  handleAssistantText(sessionID: string, text: string): Promise<void>
  handlePermission(permission: PendingPermission): Promise<void>
  handlePermissionResolved(resolution: PermissionResolution): Promise<void>
  handleQuestion(question: PendingQuestion): Promise<void>
  handleQuestionResolved(resolution: QuestionResolution): Promise<void>
  handleSession(session: Session): Promise<void>
  /** Re-list state on (re)connect. */
  handleReplayRefresh?(): Promise<void>
  /** Called once the SSE stream connects with a valid content type. */
  handleStreamReady?(): Promise<void>
  /** Reconcile after a skipped, undecodable critical event (also mid-stream). */
  handleEventRepairRefresh?(): Promise<void>
}

/**
 * A critical event (permission/question/session) that could not become
 * actionable state — failed to decode, or decoded but missing a required field
 * — yet whose state can be reconciled from the REST list endpoints. parseSSE
 * skips it, advances the cursor, then reconciles, so one bad frame neither
 * wedges the stream nor hides a pending confirmation until the next reconnect.
 */
export class RepairableEventError extends Error {
  constructor(
    readonly eventType: string,
    override readonly cause: unknown,
  ) {
    super(`${eventType}: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = "RepairableEventError"
  }
}

/** A reconnect-triggered reconcile failed; propagate so the stream restarts. */
export class ReplayRefreshError extends Error {
  constructor(override readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = "ReplayRefreshError"
  }
}

const MISSING_PERMISSION_FIELDS = "missing id or sessionID"
const MISSING_SESSION_ID = "missing info.id"
const MISSING_QUESTION_FIELDS = "missing sessionID, messageID, or callID"

interface Envelope {
  directory?: string
  payload?: { type?: string; properties?: any }
}

/** A field on a remote payload had a type Go's typed unmarshal would reject. */
class DecodeError extends Error {}

/**
 * Strict scalar decoders mirroring Go's typed `json.Unmarshal`: an absent or
 * null field is the zero value, a correctly-typed field passes through, and any
 * other type is a decode error. JSON.parse hands us `any`, so without these a
 * number where a string belongs would reach the engine and crash prompt
 * rendering (`.trim()`) or misroute a blocker — exactly what Go rejected at the
 * boundary. They are the single definition of "valid scalar" shared by every
 * decoder below and by the REST hydration mappers.
 */
export function decodeString(value: unknown, field: string): string {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  throw new DecodeError(`${field} must be a string`)
}

function decodeBoolean(value: unknown, field: string): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === "boolean") return value
  throw new DecodeError(`${field} must be a boolean`)
}

function decodeStringArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new DecodeError(`${field} must be an array of strings`)
  }
  return value
}

function decodeOptionalNumber(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null
  if (typeof value === "number") return value
  throw new DecodeError(`${field} must be a number`)
}

/**
 * Route one decoded SSE frame to the handler. Throws RepairableEventError for a
 * critical event that cannot become state (caller skips + reconciles), and
 * propagates a ReplayRefreshError from a reconnect reconcile. Returns quietly
 * for events that are intentionally ignored (deltas, non-final text, etc.).
 */
export async function dispatchEvent(data: string | Envelope, handler: EventHandler): Promise<void> {
  const envelope: Envelope = typeof data === "string" ? JSON.parse(data) : data
  const directory = envelope.directory ?? ""
  const payload = envelope.payload ?? {}
  const props = payload.properties ?? {}

  switch (payload.type) {
    case "server.connected":
      if (handler.handleReplayRefresh) await handler.handleReplayRefresh()
      return
    case "message.part.delta":
      return
    case "permission.asked": {
      // Strict decode mirrors Go's typed unmarshal: a wrong-typed id/sessionID/
      // permission, or a patterns value that is not []string, is undecodable —
      // not a lenient coercion. Reconcile rather than feed the engine a value
      // that would crash prompt rendering on .trim() and wedge the blocker.
      let permission: PendingPermission
      try {
        permission = permissionFromEvent(props)
      } catch (err) {
        throw new RepairableEventError("permission.asked", err)
      }
      if (permission.id === "" || permission.sessionID === "") {
        throw new RepairableEventError("permission.asked", new Error(MISSING_PERMISSION_FIELDS))
      }
      permission.directory = directory
      await handler.handlePermission(permission)
      return
    }
    case "permission.replied": {
      const resolution = permissionResolutionFromEvent(props)
      if (!resolution) return
      if (resolution.directory === "") resolution.directory = directory
      await handler.handlePermissionResolved(resolution)
      return
    }
    case "session.created": {
      let session: Session | null
      try {
        session = sessionFromEvent(props, directory)
      } catch (err) {
        throw new RepairableEventError("session.created", err)
      }
      if (!session) {
        throw new RepairableEventError("session.created", new Error(MISSING_SESSION_ID))
      }
      await handler.handleSession(session)
      return
    }
    case "message.part.updated": {
      const update = questionUpdateFromEvent(props, directory)
      if (update.kind === "incomplete") {
        throw new RepairableEventError("message.part.updated", new Error(MISSING_QUESTION_FIELDS))
      }
      if (update.kind === "pending") return handler.handleQuestion(update.question)
      if (update.kind === "resolved") return handler.handleQuestionResolved(update.resolution)
      const text = assistantTextFromEvent(props)
      if (!text) return
      await handler.handleAssistantText(text.sessionID, text.text)
      return
    }
    default:
      return
  }
}

/** Strictly decode a permission from an SSE payload or a REST `/permission`
 * row (same shape); throws on a wrong-typed field. The caller supplies the
 * directory for REST rows, where it is not part of the body. */
export function permissionFromEvent(props: any): PendingPermission {
  return {
    id: decodeString(props?.id, "id"),
    sessionID: decodeString(props?.sessionID, "sessionID"),
    permission: decodeString(props?.permission, "permission"),
    patterns: decodeStringArray(props?.patterns, "patterns"),
    directory: decodeString(props?.directory, "directory"),
  }
}

interface AssistantText {
  sessionID: string
  text: string
}

export function assistantTextFromEvent(props: any): AssistantText | null {
  const part = props?.part
  if (!part) return null
  // Strict decode, mirroring Go's typed unmarshal: a wrong-typed field throws so
  // the caller skips the part (Go logged + ignored it), never coercing a number
  // into a chat target or message body.
  const type = decodeString(part.type, "part.type")
  const ignored = decodeBoolean(part.ignored, "part.ignored")
  const end = decodeOptionalNumber(part.time?.end, "part.time.end")
  const sessionID = decodeString(part.sessionID, "part.sessionID")
  const text = decodeString(part.text, "part.text")
  // Only surface a completed text part: type "text", not ignored, with an end
  // time. Streaming deltas and reasoning parts must not reach chat.
  if (type !== "text" || ignored || end === null || sessionID === "" || text === "") {
    return null
  }
  return { sessionID, text }
}

function permissionResolutionFromEvent(props: any): PermissionResolution | null {
  const resolution: PermissionResolution = {
    sessionID: props?.sessionID ?? "",
    requestID: props?.requestID ?? "",
    directory: props?.directory ?? "",
  }
  if (resolution.sessionID === "" && resolution.requestID === "") return null
  return resolution
}

function sessionFromEvent(props: any, directory: string): Session | null {
  const info = props?.info
  if (!info) return null
  // Strict decode mirrors Go's typed unmarshal: a wrong-typed id/title/parentID
  // throws (the caller reconciles), a missing id is the zero value → not ready.
  const id = decodeString(info.id, "info.id")
  if (id === "") return null
  return {
    id,
    title: decodeString(info.title, "info.title"),
    parentID: decodeString(info.parentID, "info.parentID"),
    directory: decodeString(info.directory, "info.directory") || directory,
  }
}

export type QuestionUpdate =
  | { kind: "pending"; question: PendingQuestion }
  | { kind: "resolved"; resolution: QuestionResolution }
  | { kind: "none" }
  | { kind: "incomplete" }

export function questionUpdateFromEvent(props: any, directory: string): QuestionUpdate {
  const part = props?.part
  if (!part) return { kind: "none" }
  // Strict decode mirrors Go's single typed unmarshal of the part struct: a
  // wrong-typed status (a number read as "resolved" → clears the wrong blocker)
  // or externalResultReady ("false" read as true → surfaces a bogus prompt) is
  // undecodable, so signal incomplete and let the caller reconcile.
  let sessionID: string
  let messageID: string
  let callID: string
  let status: string
  let ready: boolean
  try {
    if (decodeString(part.type, "part.type") !== "tool" || decodeString(part.tool, "part.tool") !== "question") {
      return { kind: "none" }
    }
    sessionID = decodeString(part.sessionID, "part.sessionID")
    messageID = decodeString(part.messageID, "part.messageID")
    callID = decodeString(part.callID, "part.callID")
    status = decodeString(part.state?.status, "state.status")
    ready = decodeBoolean(part.state?.metadata?.externalResultReady, "state.metadata.externalResultReady")
  } catch {
    return { kind: "incomplete" }
  }
  if (sessionID === "" || messageID === "" || callID === "") return { kind: "incomplete" }

  const resolution: QuestionResolution = { sessionID, messageID, callID, directory }
  if (status !== "running") {
    if (status === "" || status === "pending") return { kind: "none" }
    return { kind: "resolved", resolution }
  }
  if (!ready) return { kind: "none" }
  // Strict decode, mirroring Go's typed unmarshal and the permission.asked
  // patterns guard: a wrong-typed questions field is undecodable, not a lenient
  // coercion — signal incomplete so the caller reconciles instead of surfacing
  // an empty-question prompt.
  const rawQuestions = part.state?.input?.questions
  if (rawQuestions !== undefined && !Array.isArray(rawQuestions)) return { kind: "incomplete" }
  // Mirror Go's []bridge.Question unmarshal: a wrong-typed nested field (header,
  // question, option label/description) is undecodable. Coercing it would crash
  // prompt rendering on .trim() and wedge the blocker, so reconcile instead.
  if (Array.isArray(rawQuestions) && rawQuestions.some(questionHasWrongTypes)) return { kind: "incomplete" }
  const questions: Question[] = Array.isArray(rawQuestions)
    ? rawQuestions.map((q: any): Question => ({
        header: q?.header ?? "",
        question: q?.question ?? "",
        options: Array.isArray(q?.options)
          ? q.options.map((o: any): QuestionOptionLike => ({ label: o?.label ?? "", description: o?.description ?? "" }))
          : [],
        multiple: q?.multiple ?? false,
      }))
    : []
  return {
    kind: "pending",
    question: { sessionID, messageID, callID, questions, directory },
  }
}

type QuestionOptionLike = { label: string; description: string }

/** Whether a decoded question carries a nested field of the wrong type, which
 * Go's typed unmarshal would have rejected. Keeps malformed values out of the
 * engine, where rendering calls `.trim()` on the string fields. */
function questionHasWrongTypes(question: any): boolean {
  if (question?.header !== undefined && typeof question.header !== "string") return true
  if (question?.question !== undefined && typeof question.question !== "string") return true
  // Go's `Multiple bool` rejects a string like "false"; Boolean("false") is true,
  // which would flip a single-select question to multi-select. Reconcile instead.
  if (question?.multiple !== undefined && typeof question.multiple !== "boolean") return true
  if (question?.options === undefined) return false
  if (!Array.isArray(question.options)) return true
  return question.options.some(
    (option: any) =>
      (option?.label !== undefined && typeof option.label !== "string") ||
      (option?.description !== undefined && typeof option.description !== "string"),
  )
}

/**
 * Parse an SSE byte stream, dispatching each `\n\n`-delimited frame. After a
 * skipped repairable event the cursor advances first, then the handler
 * reconciles — so a failing reconcile can never replay the bad event and wedge
 * the stream. Ported from the Go `parseSSE`.
 */
export async function parseSSE(
  stream: ReadableStream<Uint8Array>,
  handler: EventHandler,
  setLastEventID: (id: string) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const decoder = new TextDecoder()
  let buffer = ""
  let data = ""
  let eventID = ""

  const flush = async (): Promise<void> => {
    let reconcile = false
    if (data.length > 0) {
      try {
        await dispatchEvent(data, handler)
      } catch (err) {
        if (err instanceof ReplayRefreshError) throw err
        if (err instanceof RepairableEventError) {
          console.warn("remote bridge reconciling after undecodable event", err.eventType, err.cause)
          reconcile = true
        } else {
          console.warn("remote bridge ignored event", err)
        }
      }
      data = ""
    }
    if (eventID !== "") {
      await setLastEventID(eventID)
      eventID = ""
    }
    if (reconcile && handler.handleEventRepairRefresh) {
      try {
        await handler.handleEventRepairRefresh()
      } catch (err) {
        console.warn("remote bridge reconcile after undecodable event failed", err)
      }
    }
  }

  const handleLine = async (line: string): Promise<void> => {
    if (line === "") return flush()
    if (line.startsWith("id:")) {
      eventID = line.slice("id:".length).trim()
      return
    }
    if (!line.startsWith("data:")) return
    if (data.length > 0) data += "\n"
    data += line.slice("data:".length).replace(/^ /, "")
  }

  const reader = stream.getReader()
  // A read() blocked on an idle stream never re-checks the top-of-loop abort, so
  // cancel the reader on abort: the pending read resolves done and the loop exits.
  const cancelOnAbort = () => void reader.cancel().catch(() => {})
  if (signal) {
    if (signal.aborted) cancelOnAbort()
    else signal.addEventListener("abort", cancelOnAbort, { once: true })
  }
  try {
    for (;;) {
      if (signal?.aborted) return
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "")
        buffer = buffer.slice(newline + 1)
        await handleLine(line)
      }
    }
    if (signal?.aborted) return
    // Flush a trailing frame with no terminating blank line (mirrors Go's final flush).
    if (buffer !== "") await handleLine(buffer.replace(/\r$/, ""))
    await flush()
  } catch (err) {
    // Match Go's deferred Body.Close: abandon the stream on any error path, not
    // just abort, so a thrown dispatch/reconcile error cannot leak the connection.
    void reader.cancel().catch(() => {})
    throw err
  } finally {
    signal?.removeEventListener("abort", cancelOnAbort)
    reader.releaseLock()
  }
}
