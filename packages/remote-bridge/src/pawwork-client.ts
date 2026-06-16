import { parseSSE, questionUpdateFromEvent, type EventHandler, ReplayRefreshError } from "./pawwork-events.ts"
import type {
  EventCursorStore,
  PendingPermission,
  PendingQuestion,
  PermissionReply,
  Session,
  Sidecar,
} from "./types.ts"

export class HTTPStatusError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly statusCode: number,
    readonly status: string,
    readonly body: string,
  ) {
    super(`${method} ${path} failed: ${status} ${body}`)
    this.name = "HTTPStatusError"
  }
}

/**
 * The event stream connected (2xx) but did not speak text/event-stream.
 * Retrying cannot fix a protocol mismatch, so it is fatal and must stop the
 * reconnect loop rather than spin forever.
 */
export class StreamProtocolError extends Error {
  constructor(readonly contentType: string) {
    super(`GET /global/event failed: expected text/event-stream, got "${contentType}"`)
    this.name = "StreamProtocolError"
  }
}

export function isFatalStreamError(err: unknown): boolean {
  if (err instanceof StreamProtocolError) return true
  if (err instanceof HTTPStatusError) return err.statusCode === 401 || err.statusCode === 403 || err.statusCode === 404
  return false
}

const JSON_TIMEOUT_MS = 30_000

export class PawWorkClient implements Sidecar {
  private readonly baseURL: string
  private readonly username: string
  private readonly password: string
  private readonly defaultDirectory: string
  private lastEventID = ""
  private eventCursorStore: EventCursorStore | null = null
  private readonly sessionDirectories = new Map<string, string>()

  constructor(opts: { baseURL: string; username?: string; password?: string; directory?: string }) {
    this.baseURL = opts.baseURL.replace(/\/+$/, "")
    this.username = opts.username ?? ""
    this.password = opts.password ?? ""
    this.defaultDirectory = opts.directory ?? ""
  }

  setEventCursorStore(store: EventCursorStore | null): void {
    this.eventCursorStore = store
    if (this.lastEventID === "") this.lastEventID = store?.eventCursor() ?? ""
  }

  async createSession(): Promise<string> {
    const session = await this.doJSON<{ id: string; directory?: string }>(
      this.defaultDirectory,
      "POST",
      "/session",
      {},
    )
    const directory = session.directory || this.defaultDirectory
    this.rememberSession({ id: session.id, directory })
    return session.id
  }

  async sendPrompt(sessionID: string, text: string): Promise<void> {
    await this.doSessionJSON(sessionID, "POST", `/session/${encodeURIComponent(sessionID)}/prompt_async`, {
      parts: [{ type: "text", text }],
    })
  }

  async listSessions(limit: number): Promise<Session[]> {
    if (limit < 0) limit = 5
    let path = "/experimental/session?sort=updated"
    if (this.defaultDirectory !== "") {
      path = `/experimental/session?directory=${encodeURIComponent(this.defaultDirectory)}&sort=updated`
    }
    if (limit > 0) path += `&limit=${limit}`
    const raw = await this.doJSON<Array<{ id: string; title?: string; parentID?: string; directory?: string }>>(
      "",
      "GET",
      path,
    )
    return raw.map((item) => {
      const session: Session = {
        id: item.id,
        title: item.title ?? "",
        parentID: item.parentID ?? "",
        directory: item.directory || this.defaultDirectory,
      }
      this.rememberSession(session)
      return session
    })
  }

  async abortSession(sessionID: string): Promise<boolean> {
    return (
      (await this.doSessionJSON<boolean>(sessionID, "POST", `/session/${encodeURIComponent(sessionID)}/abort`)) ?? false
    )
  }

  async replyPermission(permission: PendingPermission, reply: PermissionReply): Promise<void> {
    const body: Record<string, unknown> = { reply: reply.reply }
    if (reply.message !== "") body.message = reply.message
    const directory = permission.directory || (await this.directoryForSession(permission.sessionID))
    await this.doJSON(directory, "POST", `/permission/${encodeURIComponent(permission.id)}/reply`, body)
  }

  async submitQuestion(pending: PendingQuestion, answers: string[][]): Promise<void> {
    const body = {
      kind: "submit",
      messageID: pending.messageID,
      callID: pending.callID,
      payload: { answers },
    }
    const directory = pending.directory || (await this.directoryForSession(pending.sessionID))
    await this.doJSON(directory, "POST", `/session/${encodeURIComponent(pending.sessionID)}/tool/respond`, body)
  }

  async listPermissions(signal?: AbortSignal): Promise<PendingPermission[]> {
    const permissions: PendingPermission[] = []
    for (const directory of this.knownDirectories()) {
      let raw: Array<{ id: string; sessionID: string; permission: string; patterns?: string[] }>
      try {
        raw = await this.doJSON(directory, "GET", "/permission", undefined, signal)
      } catch (err) {
        if (!canSkipHydrationDirectoryError(signal, err)) throw err
        console.warn("remote bridge could not list permissions", directory, err)
        continue
      }
      for (const item of raw) {
        permissions.push({
          id: item.id,
          sessionID: item.sessionID,
          permission: item.permission,
          patterns: item.patterns ?? [],
          directory,
        })
      }
    }
    return permissions
  }

  async listQuestions(signal?: AbortSignal): Promise<PendingQuestion[]> {
    const questions: PendingQuestion[] = []
    for (const directory of this.knownDirectories()) {
      let raw: any[]
      try {
        raw = await this.doJSON(directory, "GET", "/external-result", undefined, signal)
      } catch (err) {
        if (!canSkipHydrationDirectoryError(signal, err)) throw err
        console.warn("remote bridge could not list questions", directory, err)
        continue
      }
      for (const data of raw) {
        const update = questionUpdateFromEvent(data, directory)
        if (update.kind === "pending") questions.push(update.question)
      }
    }
    return questions
  }

  async streamEvents(handler: EventHandler, signal?: AbortSignal): Promise<void> {
    const lastEventID = this.lastEventIDValue()
    const headers: Record<string, string> = { accept: "text/event-stream" }
    if (lastEventID !== "") headers["Last-Event-ID"] = lastEventID
    this.authorize(headers)
    const res = await fetch(this.baseURL + "/global/event", { method: "GET", headers, signal })
    if (res.status < 200 || res.status >= 300) {
      throw new HTTPStatusError("GET", "/global/event", res.status, statusText(res), (await safeBody(res)).trim())
    }
    const mediaType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()
    if (mediaType !== "text/event-stream") {
      throw new StreamProtocolError(res.headers.get("content-type") ?? "")
    }
    if (handler.handleStreamReady) await handler.handleStreamReady()
    if (!res.body) return
    const wrapped = new ClientEventHandler(this, handler, lastEventID !== "")
    await parseSSE(res.body, wrapped, (id) => this.setLastEventID(id), signal)
  }

  private async doJSON<T = void>(
    directory: string,
    method: string,
    path: string,
    input?: unknown,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    // Bound every JSON request so a stalled server cannot hang startup/hydration.
    // The SSE stream (streamEvents) builds its own request and is exempt.
    const timeout = AbortSignal.timeout(JSON_TIMEOUT_MS)
    const signal = externalSignal ? AbortSignal.any([externalSignal, timeout]) : timeout
    const headers: Record<string, string> = {}
    let body: string | undefined
    if (input !== undefined) {
      body = JSON.stringify(input)
      headers["content-type"] = "application/json"
    }
    if (directory !== "") headers["x-opencode-directory"] = directory
    this.authorize(headers)
    const res = await fetch(this.baseURL + path, { method, headers, body, signal })
    if (res.status < 200 || res.status >= 300) {
      throw new HTTPStatusError(method, path, res.status, statusText(res), (await safeBody(res)).trim())
    }
    const text = await res.text()
    return (text === "" ? undefined : JSON.parse(text)) as T
  }

  private doSessionJSON<T = void>(sessionID: string, method: string, path: string, input?: unknown): Promise<T> {
    return this.directoryForSession(sessionID).then((directory) => this.doJSON<T>(directory, method, path, input))
  }

  private async directoryForSession(sessionID: string): Promise<string> {
    if (sessionID === "") return this.defaultDirectory
    const cached = this.sessionDirectories.get(sessionID)
    if (cached) return cached
    const session = await this.doJSON<{ id: string; directory?: string }>(
      "",
      "GET",
      `/session/${encodeURIComponent(sessionID)}`,
    )
    this.rememberSession({ id: session.id, directory: session.directory ?? "" })
    return session.directory || this.defaultDirectory
  }

  rememberSession(session: { id: string; directory: string }): void {
    if (session.id === "" || session.directory === "") return
    this.sessionDirectories.set(session.id, session.directory)
  }

  private knownDirectories(): string[] {
    const seen = new Set<string>()
    const directories: string[] = []
    if (this.defaultDirectory !== "") {
      seen.add(this.defaultDirectory)
      directories.push(this.defaultDirectory)
    }
    // Sort the map-derived directories for a stable hydration order.
    const extra: string[] = []
    for (const directory of this.sessionDirectories.values()) {
      if (directory === "" || seen.has(directory)) continue
      seen.add(directory)
      extra.push(directory)
    }
    extra.sort()
    directories.push(...extra)
    return directories.length === 0 ? [""] : directories
  }

  private authorize(headers: Record<string, string>): void {
    if (this.username === "" && this.password === "") return
    const username = this.username || "opencode"
    headers["Authorization"] = "Basic " + Buffer.from(`${username}:${this.password}`).toString("base64")
  }

  lastEventIDValue(): string {
    if (this.lastEventID !== "") return this.lastEventID
    return this.eventCursorStore?.eventCursor() ?? ""
  }

  private async setLastEventID(id: string): Promise<void> {
    if (id === "") return
    if (this.eventCursorStore) await this.eventCursorStore.setEventCursor(id)
    this.lastEventID = id
  }
}

/**
 * Wraps the gateway's handler to (a) remember each event's session→directory
 * mapping, and (b) reconcile via the gateway's hydrate on reconnect / after a
 * skipped event. Mirrors the Go `clientEventHandler`.
 */
class ClientEventHandler implements EventHandler {
  constructor(
    private readonly client: PawWorkClient,
    private readonly next: EventHandler,
    private readonly reconnecting: boolean,
  ) {}

  handleAssistantText(sessionID: string, text: string) {
    return this.next.handleAssistantText(sessionID, text)
  }
  handlePermission(permission: PendingPermission) {
    this.client.rememberSession({ id: permission.sessionID, directory: permission.directory })
    return this.next.handlePermission(permission)
  }
  handlePermissionResolved(resolution: { sessionID: string; directory: string } & any) {
    this.client.rememberSession({ id: resolution.sessionID, directory: resolution.directory })
    return this.next.handlePermissionResolved(resolution)
  }
  handleQuestion(question: PendingQuestion) {
    this.client.rememberSession({ id: question.sessionID, directory: question.directory })
    return this.next.handleQuestion(question)
  }
  handleQuestionResolved(resolution: { sessionID: string; directory: string } & any) {
    this.client.rememberSession({ id: resolution.sessionID, directory: resolution.directory })
    return this.next.handleQuestionResolved(resolution)
  }
  handleSession(session: Session) {
    this.client.rememberSession(session)
    return this.next.handleSession(session)
  }

  async handleReplayRefresh(): Promise<void> {
    if (!this.reconnecting) return
    try {
      await this.hydrateNext()
    } catch (err) {
      throw new ReplayRefreshError(err)
    }
  }

  async handleEventRepairRefresh(): Promise<void> {
    await this.hydrateNext()
  }

  private async hydrateNext(): Promise<void> {
    if (this.next.handleReplayRefresh) await this.next.handleReplayRefresh()
  }
}

/**
 * Whether a per-directory hydration failure is transient enough to skip and
 * continue. Only request timeouts, rate limits, 5xx, and network/timeout
 * signals qualify; JSON/protocol errors surface so a pending permission or
 * question is never silently dropped. A cancelled caller signal is a
 * whole-operation cancel, not a per-directory blip — surface it.
 */
function canSkipHydrationDirectoryError(signal: AbortSignal | undefined, err: unknown): boolean {
  if (signal?.aborted) return false
  if (err instanceof HTTPStatusError) {
    return err.statusCode === 408 || err.statusCode === 429 || err.statusCode >= 500
  }
  if (err instanceof DOMException) return err.name === "TimeoutError" || err.name === "AbortError"
  if (err instanceof TypeError) return true // fetch network failure
  return false
}

function statusText(res: Response): string {
  return `${res.status} ${res.statusText}`.trim()
}

async function safeBody(res: Response): Promise<string> {
  try {
    const text = await res.text()
    return text.slice(0, 4096)
  } catch {
    return ""
  }
}
