import type { EventHandler } from "./pawwork-events.ts"
import { t, type Locale } from "./i18n.ts"
import { SessionPointers as SessionPointersStore } from "./session-pointers.ts"
import { PartialDeliveryError } from "./types.ts"
import type {
  Message,
  PendingPermission,
  PendingQuestion,
  PermissionReply,
  PermissionResolution,
  Platform,
  Question,
  QuestionResolution,
  Session,
  SessionPointers,
  Sidecar,
} from "./types.ts"

/**
 * The conversational core. It owns the remoteKey→session pointers, the single
 * active chat target per session, and the ordered set of pending blockers
 * (permission/question prompts) — surfacing exactly one at a time and only once
 * it has actually reached chat. Ported from the Go `bridge.Engine`.
 *
 * JS is single threaded, so the Go mutex is gone: every state mutation here runs
 * synchronously between `await` points, which is at least as atomic as Go's
 * per-section locking. Network I/O (delivery, sidecar calls) happens outside
 * those synchronous sections, exactly as Go released the lock for I/O.
 */
export class Engine implements EventHandler {
  private readonly active = new Map<string, Delivery>()
  private readonly platforms = new Map<string, Platform>()
  private readonly permissions = new Map<string, PendingPermission>()
  private readonly questions = new Map<string, PendingQuestion>()
  // Coalesces concurrent first-session creation per remote key. Inbound messages
  // are dispatched fire-and-forget, so two for a brand-new conversation can
  // interleave at `await createSession()`; without this they would both create a
  // session and the second setCurrent would orphan the first. (Deliberately
  // stricter than the Go original, which has the same race.)
  private readonly sessionCreates = new Map<string, Promise<string>>()
  private blockerOrder: BlockerRef[] = []

  constructor(
    private readonly sidecar: Sidecar,
    private readonly pointers: SessionPointers = SessionPointersStore.memory(),
    private readonly locale: Locale = "en",
  ) {}

  currentSession(remoteKey: string): string {
    return this.pointers.get(remoteKey)
  }

  registerPlatform(platform: Platform): void {
    if (!platform || platform.name.trim() === "") return
    this.platforms.set(platform.name, platform)
  }

  /**
   * Drop a platform from routing when its channel disconnects: remove it from the
   * reconstruct-reply index and discard any active delivery target pointing at it,
   * so a later assistant event for one of its sessions can't push to a stopped
   * platform. Liveness of *inbound* messages is enforced by the gateway's message
   * handler (it owns the live platform set); the remoteKey→session pointers are
   * pruned separately, since they outlive the live platform.
   */
  unregisterPlatform(name: string): void {
    if (name.trim() === "") return
    this.platforms.delete(name)
    for (const [sessionID, delivery] of this.active) {
      if (delivery.platform.name === name) this.active.delete(sessionID)
    }
  }

  async registerSession(session: Session): Promise<void> {
    if (session.id === "" || session.parentID === "") return
    await this.pointers.setParent(session.id, session.parentID)
  }

  async handleMessage(platform: Platform, msg: Message): Promise<void> {
    const text = (msg.content ?? "").trim()
    if (text === "") return
    const key = remoteKey(platform, msg)
    if (await this.handleCommand(platform, msg, key, text)) return

    let sessionID: string
    try {
      sessionID = await this.ensureSession(key)
    } catch (err) {
      await replyQuietly(platform, msg.replyCtx, t(this.locale, "err.startSession") + message(err))
      throw err
    }

    if (await this.handlePendingReply(platform, msg, sessionID, text)) return

    this.setActive(sessionID, platform, msg.replyCtx)
    // Retry an undelivered head prompt now that the user is reachable on this
    // target. Best-effort: the message below still goes through as an ordinary
    // prompt, since an unshown blocker must never intercept it.
    await this.surfaceActiveBlocker(sessionID).catch(() => {})
    try {
      await this.sidecar.sendPrompt(sessionID, text)
    } catch (err) {
      await replyQuietly(platform, msg.replyCtx, t(this.locale, "err.sendMessage") + message(err))
      throw err
    }
  }

  async handleAssistantText(sessionID: string, text: string): Promise<void> {
    if (text === "") return
    const target = await this.activeDelivery(sessionID)
    if (!target) return
    await sendDeliveryWithRetry(target, text)
  }

  async handlePermission(permission: PendingPermission): Promise<void> {
    this.setPendingPermission(permission)
    await this.surfaceActiveBlocker(permission.sessionID)
  }

  async handleQuestion(question: PendingQuestion): Promise<void> {
    this.setPendingQuestion(question)
    await this.surfaceActiveBlocker(question.sessionID)
  }

  async handlePermissionResolved(resolution: PermissionResolution): Promise<void> {
    let affected = ""
    if (resolution.requestID !== "") {
      const permission = this.permissions.get(resolution.requestID)
      if (permission) affected = permission.sessionID
      this.clearPermissionKey(resolution.requestID)
    } else if (resolution.sessionID !== "") {
      affected = resolution.sessionID
      this.clearPermissions((permission) => permission.sessionID === resolution.sessionID)
    }
    if (affected === "") return
    await this.surfaceActiveBlocker(affected)
  }

  async handleQuestionResolved(resolution: QuestionResolution): Promise<void> {
    let affected = ""
    if (resolution.callID !== "" || resolution.messageID !== "") {
      for (const [key, question] of this.questions) {
        const callMatches = resolution.callID === "" || question.callID === resolution.callID
        const messageMatches = resolution.messageID === "" || question.messageID === resolution.messageID
        if (callMatches && messageMatches) {
          affected = question.sessionID
          this.clearQuestionKey(key)
          break
        }
      }
    } else if (resolution.sessionID !== "") {
      affected = resolution.sessionID
      this.clearQuestions((question) => question.sessionID === resolution.sessionID)
    }
    if (affected === "") return
    await this.surfaceActiveBlocker(affected)
  }

  handleSession(session: Session): Promise<void> {
    return this.registerSession(session)
  }

  // --- pending blocker bookkeeping ------------------------------------------

  private setPendingPermission(permission: PendingPermission): void {
    if (permission.sessionID === "") return
    const key = permissionKey(permission)
    if (!this.permissions.has(key)) {
      this.blockerOrder.push({ kind: "permission", key, delivered: false })
    }
    this.permissions.set(key, permission)
  }

  private setPendingQuestion(question: PendingQuestion): void {
    if (question.sessionID === "") return
    const key = questionKey(question)
    if (!this.questions.has(key)) {
      this.blockerOrder.push({ kind: "question", key, delivered: false })
    }
    this.questions.set(key, question)
  }

  /**
   * Answer the session's single visible blocker, if the inbound text is a reply
   * to it. Returns true when the message was consumed as an answer (so the
   * caller must not also forward it as an ordinary prompt).
   */
  private async handlePendingReply(
    platform: Platform,
    msg: Message,
    sessionID: string,
    text: string,
  ): Promise<boolean> {
    const blocker = this.pendingBlocker(sessionID)
    if (!blocker) return false
    if (blocker.kind === "permission") {
      const reply = permissionReplyForText(text)
      if (reply === "") {
        await platform.reply(msg.replyCtx, t(this.locale, "permission.notUnderstoodPrefix") + t(this.locale, "permission.replyHint"))
        return true
      }
      try {
        await this.sidecar.replyPermission(blocker.permission, { reply, message: "" })
      } catch (err) {
        await replyQuietly(platform, msg.replyCtx, t(this.locale, "err.answerPermission") + message(err))
        throw err
      }
      this.clearPendingPermission(blocker.permission)
      await this.surfaceActiveBlocker(sessionID)
      return true
    }
    // question blocker
    let answers: string[][]
    try {
      answers = answersForQuestionText(blocker.question, text, this.locale)
    } catch (err) {
      await platform.reply(msg.replyCtx, message(err))
      return true
    }
    try {
      await this.sidecar.submitQuestion(blocker.question, answers)
    } catch (err) {
      await replyQuietly(platform, msg.replyCtx, t(this.locale, "err.submitAnswer") + message(err))
      throw err
    }
    this.clearPendingQuestion(blocker.question)
    await this.surfaceActiveBlocker(sessionID)
    return true
  }

  /**
   * The single active blocker for a root session: the earliest live one, and
   * only once it has actually been delivered to chat. A queued-but-not-yet-shown
   * blocker is never returned, so a user reply only answers the prompt currently
   * in front of them.
   */
  private pendingBlocker(sessionID: string): PendingBlocker | null {
    const root = this.pointers.rootSession(sessionID)
    for (const ref of this.blockerOrder) {
      if (!this.blockerLiveForRoot(ref, root)) continue
      if (!ref.delivered) return null
      if (ref.kind === "permission") return { kind: "permission", permission: this.permissions.get(ref.key)! }
      return { kind: "question", question: this.questions.get(ref.key)! }
    }
    return null
  }

  /**
   * Deliver the root's current head prompt if it has not been shown yet, so chat
   * only ever displays one pending item at a time. A head that fails to deliver
   * is kept undelivered, never dropped: it stays unanswerable so it cannot
   * intercept an ordinary message, and the next inbound message, a resolved
   * sibling, or a reconnect hydrate retries surfacing it. Throws the delivery
   * error so the caller can report it; a missing chat target resolves quietly
   * and leaves the head queued.
   */
  private async surfaceActiveBlocker(sessionID: string): Promise<void> {
    const head = this.headPromptToDeliver(sessionID)
    if (!head) return
    const delivered = await this.replyToActive(head.sessionID, head.content)
    if (!delivered) return
    this.markBlockerDelivered(head.ref)
  }

  private headPromptToDeliver(sessionID: string): { ref: BlockerRef; sessionID: string; content: string } | null {
    const root = this.pointers.rootSession(sessionID)
    for (const candidate of this.blockerOrder) {
      if (!this.blockerLiveForRoot(candidate, root)) continue
      if (candidate.delivered) return null
      if (candidate.kind === "permission") {
        const permission = this.permissions.get(candidate.key)!
        return { ref: candidate, sessionID: permission.sessionID, content: permissionPrompt(permission, this.locale) }
      }
      const question = this.questions.get(candidate.key)!
      return { ref: candidate, sessionID: question.sessionID, content: questionPrompt(question, this.locale) }
    }
    return null
  }

  private markBlockerDelivered(ref: BlockerRef): void {
    for (const current of this.blockerOrder) {
      if (current.kind === ref.kind && current.key === ref.key) {
        current.delivered = true
        return
      }
    }
  }

  private blockerLiveForRoot(ref: BlockerRef, root: string): boolean {
    if (ref.kind === "permission") {
      const permission = this.permissions.get(ref.key)
      return !!permission && this.pointers.rootSession(permission.sessionID) === root
    }
    const question = this.questions.get(ref.key)
    return !!question && this.pointers.rootSession(question.sessionID) === root
  }

  private clearPendingPermission(permission: PendingPermission): void {
    this.clearPermissionKey(permissionKey(permission))
  }

  private clearPermissionKey(key: string): void {
    this.permissions.delete(key)
    this.blockerOrder = this.blockerOrder.filter((ref) => !(ref.kind === "permission" && ref.key === key))
  }

  private clearPermissions(match: (permission: PendingPermission) => boolean): void {
    for (const [key, permission] of this.permissions) {
      if (match(permission)) this.permissions.delete(key)
    }
    this.blockerOrder = this.blockerOrder.filter(
      (ref) => !(ref.kind === "permission" && !this.permissions.has(ref.key)),
    )
  }

  private clearPendingQuestion(question: PendingQuestion): void {
    this.clearQuestionKey(questionKey(question))
  }

  private clearQuestionKey(key: string): void {
    this.questions.delete(key)
    this.blockerOrder = this.blockerOrder.filter((ref) => !(ref.kind === "question" && ref.key === key))
  }

  private clearQuestions(match: (question: PendingQuestion) => boolean): void {
    for (const [key, question] of this.questions) {
      if (match(question)) this.questions.delete(key)
    }
    this.blockerOrder = this.blockerOrder.filter(
      (ref) => !(ref.kind === "question" && !this.questions.has(ref.key)),
    )
  }

  // --- delivery targets ------------------------------------------------------

  private async replyToActive(sessionID: string, content: string): Promise<boolean> {
    const target = await this.activeDelivery(sessionID)
    if (!target) return false
    await sendDeliveryWithRetry(target, content)
    return true
  }

  private setActive(sessionID: string, platform: Platform, replyCtx: unknown): void {
    this.active.set(sessionID, { platform, replyCtx, proactive: false })
  }

  private async activeDelivery(sessionID: string): Promise<Delivery | null> {
    const direct = this.active.get(sessionID) ?? this.active.get(this.pointers.rootSession(sessionID))
    if (direct) return direct
    return this.restoreDelivery(sessionID)
  }

  private async restoreDelivery(sessionID: string): Promise<Delivery | null> {
    const key = this.pointers.remoteKeyForSession(sessionID)
    const platformName = key.split(":", 1)[0]
    if (!key.includes(":") || platformName === "") return null

    const platform = this.platforms.get(platformName)
    if (!platform?.reconstructReplyCtx) return null
    let replyCtx: unknown
    try {
      replyCtx = await platform.reconstructReplyCtx(key)
    } catch {
      return null
    }

    // Re-check: another message may have set an active target while we awaited.
    // Look at the root too (as activeDelivery does), so a freshly active root
    // conversation is not shadowed by a proactive child target.
    const current = this.active.get(sessionID) ?? this.active.get(this.pointers.rootSession(sessionID))
    if (current) return current
    const target: Delivery = { platform, replyCtx, proactive: true }
    this.active.set(sessionID, target)
    return target
  }

  // --- commands --------------------------------------------------------------

  private async handleCommand(platform: Platform, msg: Message, key: string, text: string): Promise<boolean> {
    const spaceIndex = text.indexOf(" ")
    const name = spaceIndex === -1 ? text : text.slice(0, spaceIndex)
    const arg = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1)
    switch (name) {
      case "/new": {
        let sessionID: string
        try {
          sessionID = await this.sidecar.createSession()
        } catch (err) {
          await replyQuietly(platform, msg.replyCtx, t(this.locale, "err.startSession") + message(err))
          throw err
        }
        try {
          await this.setCurrent(key, sessionID)
        } catch (err) {
          await replyQuietly(platform, msg.replyCtx, t(this.locale, "err.rememberSession") + message(err))
          throw err
        }
        this.setActive(sessionID, platform, msg.replyCtx)
        await platform.reply(msg.replyCtx, t(this.locale, "cmd.newSession"))
        return true
      }
      case "/sessions": {
        const trimmed = arg.trim()
        if (trimmed === "") await this.replySessionPicker(platform, msg, key)
        else await this.switchSession(platform, msg, key, trimmed)
        return true
      }
      case "/stop": {
        const sessionID = this.currentSession(key)
        if (sessionID === "") {
          await platform.reply(msg.replyCtx, t(this.locale, "cmd.noActiveSession"))
          return true
        }
        let aborted: boolean
        try {
          aborted = await this.sidecar.abortSession(sessionID)
        } catch (err) {
          await replyQuietly(platform, msg.replyCtx, t(this.locale, "err.stopRun") + message(err))
          throw err
        }
        await platform.reply(msg.replyCtx, aborted ? t(this.locale, "cmd.stopped") : t(this.locale, "cmd.noRunning"))
        return true
      }
      case "/help":
        await platform.reply(msg.replyCtx, t(this.locale, "cmd.help"))
        return true
      default:
        return false
    }
  }

  private async ensureSession(key: string): Promise<string> {
    const existing = this.currentSession(key)
    if (existing !== "") return existing
    // Coalesce concurrent first-message creation onto one in-flight promise.
    const pending = this.sessionCreates.get(key)
    if (pending) return pending
    const created = this.createSessionForKey(key)
    this.sessionCreates.set(key, created)
    try {
      return await created
    } finally {
      if (this.sessionCreates.get(key) === created) this.sessionCreates.delete(key)
    }
  }

  private async createSessionForKey(key: string): Promise<string> {
    const sessionID = await this.sidecar.createSession()
    // Another path (e.g. /new) may have bound a session while we created ours;
    // prefer it and drop the duplicate rather than overwrite the pointer.
    const current = this.currentSession(key)
    if (current !== "") return current
    await this.setCurrent(key, sessionID)
    return sessionID
  }

  private async replySessionPicker(platform: Platform, msg: Message, key: string): Promise<void> {
    let sessions: Session[]
    try {
      sessions = await this.sidecar.listSessions(5)
    } catch (err) {
      await replyQuietly(platform, msg.replyCtx, t(this.locale, "err.listSessions") + message(err))
      throw err
    }
    if (sessions.length === 0) {
      await platform.reply(msg.replyCtx, t(this.locale, "cmd.noRecent"))
      return
    }
    const lines = [t(this.locale, "cmd.recentSessions")]
    sessions.forEach((session, index) => lines.push(`${index + 1}. ${sessionLabel(session)}`))
    await platform.reply(msg.replyCtx, lines.join("\n") + "\n\n" + t(this.locale, "cmd.switchHint"))
  }

  private async switchSession(platform: Platform, msg: Message, key: string, rawIndex: string): Promise<void> {
    // Strict whole-string integer parse, matching Go's strconv.Atoi: "2abc"
    // and "2.5" are rejected, not silently truncated to 2.
    const index = /^[+-]?\d+$/.test(rawIndex) ? Number.parseInt(rawIndex, 10) : Number.NaN
    if (Number.isNaN(index) || index < 1) {
      await platform.reply(msg.replyCtx, t(this.locale, "cmd.chooseHint"))
      return
    }
    // Fetch the current list rather than trusting a cached picker: between
    // listing and picking, the recent sessions may have changed, and N must
    // resolve against what is live now, not a stale snapshot.
    let sessions: Session[]
    try {
      sessions = await this.sidecar.listSessions(5)
    } catch (err) {
      await replyQuietly(platform, msg.replyCtx, t(this.locale, "err.listSessions") + message(err))
      throw err
    }
    if (index > sessions.length) {
      await platform.reply(msg.replyCtx, t(this.locale, "cmd.onlyN", { n: sessions.length }))
      return
    }
    const session = sessions[index - 1]
    try {
      await this.registerSession(session)
      await this.setCurrent(key, session.id)
    } catch (err) {
      await replyQuietly(platform, msg.replyCtx, t(this.locale, "err.rememberSession") + message(err))
      throw err
    }
    this.setActive(session.id, platform, msg.replyCtx)
    await platform.reply(msg.replyCtx, t(this.locale, "cmd.switchedTo", { x: sessionLabel(session) }))
  }

  private setCurrent(remoteKey: string, sessionID: string): Promise<void> {
    return this.pointers.set(remoteKey, sessionID)
  }
}

type BlockerKind = "permission" | "question"

interface BlockerRef {
  kind: BlockerKind
  key: string
  delivered: boolean
}

type PendingBlocker =
  | { kind: "permission"; permission: PendingPermission }
  | { kind: "question"; question: PendingQuestion }

interface Delivery {
  platform: Platform
  replyCtx: unknown
  proactive: boolean
}

/**
 * How many times a user-visible payload is pushed to a chat target before
 * giving up, and the base backoff between attempts (scaled per attempt).
 * Mutable only so tests can drop the backoff to zero. The global SSE cursor
 * tracks ingestion and advances regardless, so a target that stays unreachable
 * is reported (logged) rather than held — holding the shared cursor would wedge
 * every session's stream.
 */
export const deliveryConfig = { attempts: 3, backoffMs: 200 }

function sendDelivery(target: Delivery, content: string): Promise<void> {
  return target.proactive
    ? target.platform.send(target.replyCtx, content)
    : target.platform.reply(target.replyCtx, content)
}

async function sendDeliveryWithRetry(target: Delivery, content: string): Promise<void> {
  let lastError: unknown
  for (let attempt = 1; attempt <= deliveryConfig.attempts; attempt++) {
    try {
      await sendDelivery(target, content)
      return
    } catch (err) {
      lastError = err
      // Part of a multi-part message already reached the user; resending the whole
      // payload would duplicate what arrived, so surface it without retrying. The
      // platform retried the failed chunk in place before giving up.
      if (err instanceof PartialDeliveryError) throw err
      if (attempt < deliveryConfig.attempts && deliveryConfig.backoffMs > 0) {
        await delay(attempt * deliveryConfig.backoffMs)
      }
    }
  }
  throw lastError
}

// --- pure rendering + parsing helpers (no engine state) ---------------------

function sessionLabel(session: Session): string {
  return session.title.trim() !== "" ? session.title : session.id
}

function permissionPrompt(permission: PendingPermission, locale: Locale): string {
  const lines = [t(locale, "permission.title")]
  if (permission.permission.trim() !== "") lines.push(permission.permission)
  for (const pattern of permission.patterns) {
    if (pattern.trim() === "") continue
    lines.push(pattern)
  }
  return lines.join("\n") + "\n\n" + t(locale, "permission.replyHint")
}

export function questionPrompt(pending: PendingQuestion, locale: Locale = "en"): string {
  if (pending.questions.length === 0) return t(locale, "question.fallback")
  const multiQuestion = pending.questions.length > 1
  const blocks: string[] = []
  pending.questions.forEach((question, qIndex) => {
    const lines: string[] = []
    // Number each question when there are several, so "one answer per line" maps
    // visibly onto them. The label is composed here, not parsed from the backend
    // header — engine owns the localized "Question N" prefix, header stays as sent.
    const label = multiQuestion ? t(locale, "question.label", { n: qIndex + 1 }) : ""
    const header = question.header.trim()
    if (label && header) lines.push(`${label} ${header}`)
    else if (label || header) lines.push(label || header)
    lines.push(question.question)
    question.options.forEach((option, index) => {
      let line = `${index + 1}. ${option.label}`
      if (option.description.trim() !== "") line += " - " + option.description
      lines.push(line)
    })
    blocks.push(lines.join("\n"))
  })
  return blocks.join("\n\n") + "\n\n" + questionReplyHint(pending.questions, locale)
}

function questionReplyHint(questions: Question[], locale: Locale): string {
  const multiQuestion = questions.length > 1
  const multiSelect = questions.some((question) => question.multiple)
  if (multiQuestion && multiSelect) return t(locale, "hint.multiQuestionMulti")
  if (multiQuestion) return t(locale, "hint.multiQuestion")
  if (multiSelect) return t(locale, "hint.singleMulti")
  return t(locale, "hint.single")
}

function permissionReplyForText(text: string): string {
  // Accepts both English and Chinese keywords regardless of the rendered locale,
  // so a reply works even if the user types in the other language. toLowerCase is
  // a no-op on Chinese, harmless here.
  switch (text.trim().toLowerCase()) {
    case "yes":
    case "y":
    case "allow":
    case "ok":
    case "是":
    case "好":
    case "好的":
    case "允许":
    case "同意":
    case "可以":
      return "once"
    case "always":
    case "always allow":
    case "总是":
    case "一直":
    case "始终":
    case "总是允许":
      return "always"
    case "no":
    case "n":
    case "deny":
    case "reject":
    case "否":
    case "不":
    case "不行":
    case "拒绝":
    case "不要":
      return "reject"
    default:
      return ""
  }
}

export function answersForQuestionText(pending: PendingQuestion, text: string, locale: Locale = "en"): string[][] {
  const questions = pending.questions
  if (questions.length === 0) return [[text]]
  if (questions.length === 1) return [answerRowForQuestion(text, questions[0])]
  const lines = text.trim().split("\n")
  if (lines.length !== questions.length) {
    throw new Error(t(locale, "answers.lineMismatch", { n: questions.length }))
  }
  return lines.map((line, index) => answerRowForQuestion(line, questions[index]))
}

function answerRowForQuestion(text: string, question: Question): string[] {
  text = text.trim()
  if (!question.multiple) return [answerTokenForQuestion(text, question)]
  return text
    .split(ANSWER_SEPARATORS)
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => answerTokenForQuestion(part, question))
}

// ASCII comma plus the full-width and ideographic commas, so replies typed on a
// Chinese keyboard ("1，3" / "1、3") parse the same as ASCII ones.
const ANSWER_SEPARATORS = /[,，、]/

function answerTokenForQuestion(text: string, question: Question): string {
  if (/^\d+$/.test(text)) {
    const index = Number.parseInt(text, 10)
    if (index >= 1 && index <= question.options.length) return question.options[index - 1].label
  }
  return text
}

function permissionKey(permission: PendingPermission): string {
  return permission.id !== "" ? permission.id : permission.sessionID
}

function questionKey(question: PendingQuestion): string {
  if (question.messageID !== "" || question.callID !== "") {
    return question.messageID + "\x00" + question.callID
  }
  return question.sessionID
}

function remoteKey(platform: Platform, msg: Message): string {
  if ((msg.sessionKey ?? "").trim() !== "") return msg.sessionKey!
  return [platform.name, msg.channelID ?? "", msg.userID ?? ""].join(":")
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Reply, swallowing a secondary delivery failure so the primary error wins. */
async function replyQuietly(platform: Platform, replyCtx: unknown, content: string): Promise<void> {
  try {
    await platform.reply(replyCtx, content)
  } catch {
    // best effort — the caller is already reporting the underlying error
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
