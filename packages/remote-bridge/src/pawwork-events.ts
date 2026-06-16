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
      // Match Go's strict decode: a wrong-typed critical field (e.g. patterns
      // sent as a string) is undecodable, not a lenient coercion — reconcile it.
      if (props.patterns !== undefined && !Array.isArray(props.patterns)) {
        throw new RepairableEventError("permission.asked", new Error("patterns must be an array"))
      }
      const permission = permissionFromEvent(props)
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
      const session = sessionFromEvent(props, directory)
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

function permissionFromEvent(props: any): PendingPermission {
  return {
    id: props?.id ?? "",
    sessionID: props?.sessionID ?? "",
    permission: props?.permission ?? "",
    patterns: Array.isArray(props?.patterns) ? props.patterns : [],
    directory: props?.directory ?? "",
  }
}

interface AssistantText {
  sessionID: string
  text: string
}

export function assistantTextFromEvent(props: any): AssistantText | null {
  const part = props?.part
  if (!part) return null
  // Only surface a completed text part: type "text", not ignored, with an end
  // time. Streaming deltas and reasoning parts must not reach chat.
  if (part.type !== "text" || part.ignored || part.time?.end == null || !part.sessionID || !part.text) {
    return null
  }
  return { sessionID: part.sessionID, text: part.text }
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
  if (!info || !info.id) return null
  return {
    id: info.id,
    title: info.title ?? "",
    parentID: info.parentID ?? "",
    directory: info.directory || directory,
  }
}

export type QuestionUpdate =
  | { kind: "pending"; question: PendingQuestion }
  | { kind: "resolved"; resolution: QuestionResolution }
  | { kind: "none" }
  | { kind: "incomplete" }

export function questionUpdateFromEvent(props: any, directory: string): QuestionUpdate {
  const part = props?.part
  if (!part || part.type !== "tool" || part.tool !== "question") return { kind: "none" }
  if (!part.sessionID || !part.messageID || !part.callID) return { kind: "incomplete" }

  const resolution: QuestionResolution = {
    sessionID: part.sessionID,
    messageID: part.messageID,
    callID: part.callID,
    directory,
  }
  const status: string = part.state?.status ?? ""
  if (status !== "running") {
    if (status === "" || status === "pending") return { kind: "none" }
    return { kind: "resolved", resolution }
  }
  if (!part.state?.metadata?.externalResultReady) return { kind: "none" }
  // Strict decode, mirroring Go's typed unmarshal and the permission.asked
  // patterns guard: a wrong-typed questions field is undecodable, not a lenient
  // coercion — signal incomplete so the caller reconciles instead of surfacing
  // an empty-question prompt.
  const rawQuestions = part.state?.input?.questions
  if (rawQuestions !== undefined && !Array.isArray(rawQuestions)) return { kind: "incomplete" }
  const questions: Question[] = Array.isArray(rawQuestions)
    ? rawQuestions.map((q: any): Question => ({
        header: q?.header ?? "",
        question: q?.question ?? "",
        options: Array.isArray(q?.options)
          ? q.options.map((o: any): QuestionOptionLike => ({ label: o?.label ?? "", description: o?.description ?? "" }))
          : [],
        multiple: Boolean(q?.multiple),
      }))
    : []
  return {
    kind: "pending",
    question: { sessionID: part.sessionID, messageID: part.messageID, callID: part.callID, questions, directory },
  }
}

type QuestionOptionLike = { label: string; description: string }

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
  } finally {
    signal?.removeEventListener("abort", cancelOnAbort)
    reader.releaseLock()
  }
  if (signal?.aborted) return
  // Flush a trailing frame with no terminating blank line (mirrors Go's final flush).
  if (buffer !== "") await handleLine(buffer.replace(/\r$/, ""))
  await flush()
}
