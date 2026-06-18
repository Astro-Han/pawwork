// Domain model + the seams the engine depends on. Ported from the Go
// `bridge` package types. Interfaces (Sidecar / SessionPointers /
// EventCursorStore) keep the engine testable: production wires the real
// PawWork client + file-backed pointers, tests pass fakes.

export interface Session {
  id: string
  title: string
  parentID: string
  directory: string
}

export interface PendingPermission {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  directory: string
}

export interface PermissionReply {
  reply: string
  message: string
}

export interface PendingQuestion {
  sessionID: string
  messageID: string
  callID: string
  questions: Question[]
  directory: string
}

export interface PermissionResolution {
  sessionID: string
  requestID: string
  directory: string
}

export interface QuestionResolution {
  sessionID: string
  messageID: string
  callID: string
  directory: string
}

export interface Question {
  header: string
  question: string
  options: QuestionOption[]
  multiple: boolean
}

export interface QuestionOption {
  label: string
  description: string
}

/** The PawWork server, as the engine needs it. `PawWorkClient` implements it. */
export interface Sidecar {
  createSession(): Promise<string>
  sendPrompt(sessionID: string, text: string): Promise<void>
  listSessions(limit: number, signal?: AbortSignal): Promise<Session[]>
  abortSession(sessionID: string): Promise<boolean>
  replyPermission(permission: PendingPermission, reply: PermissionReply): Promise<void>
  submitQuestion(pending: PendingQuestion, answers: string[][]): Promise<void>
}

export interface SessionPointers {
  get(remoteKey: string): string
  set(remoteKey: string, sessionID: string): Promise<void>
  setParent(sessionID: string, parentID: string): Promise<void>
  remoteKeyForSession(sessionID: string): string
  rootSession(sessionID: string): string
}

export interface EventCursorStore {
  eventCursor(): string
  setEventCursor(cursor: string): Promise<void>
}

/** An inbound chat message, normalized across platforms. Ported from `core.Message`. */
export interface Message {
  content: string
  /** Opaque handle the platform uses to reply in-thread; passed back to `reply`. */
  replyCtx?: unknown
  channelID?: string
  userID?: string
  /** A platform-stable conversation key; falls back to name:channel:user when empty. */
  sessionKey?: string
}

export type MessageHandler = (platform: Platform, msg: Message) => void

/**
 * Thrown by a platform's reply/send when it has already delivered part of a
 * multi-part message and then failed. The engine's delivery retry treats it as
 * terminal: resending the whole payload would duplicate the parts that already
 * arrived. Wraps the underlying cause for logging.
 */
export class PartialDeliveryError extends Error {
  constructor(readonly reason: unknown) {
    super(`partial delivery: ${reason instanceof Error ? reason.message : String(reason)}`)
    this.name = "PartialDeliveryError"
  }
}

/**
 * A chat platform the engine drives. The Vercel Chat SDK / Lark adapter is
 * wrapped to implement this so the engine stays decoupled from any one SDK,
 * exactly as the Go engine depended on cc-connect's `core.Platform`.
 */
export interface Platform {
  readonly name: string
  /**
   * Run the platform, delivering inbound messages to `handler`; resolves when
   * stopped. `onReady`, if given, fires once the platform is actually serving —
   * past any backlog drain AND after the first live receive actually returns, the
   * only proof inbound delivery works — so the gateway can defer "connected" until
   * a message would really arrive. A platform whose receive loop cannot get going
   * (e.g. a Telegram 409: another client owns the token) must reject `start()`
   * without ever firing `onReady`, so the caller surfaces it instead of "connected".
   */
  start(handler: MessageHandler, onReady?: () => void): Promise<void>
  /** Reply in-thread to the message `replyCtx` identifies. */
  reply(replyCtx: unknown, content: string): Promise<void>
  /** Proactively push to a conversation (used for restored delivery targets). */
  send(replyCtx: unknown, content: string): Promise<void>
  stop(): Promise<void>
  /**
   * Optionally rebuild a reply context from a remote key so delivery survives a
   * restart with no live inbound message. Mirrors `core.ReplyContextReconstructor`.
   */
  reconstructReplyCtx?(remoteKey: string): unknown | Promise<unknown>
}
