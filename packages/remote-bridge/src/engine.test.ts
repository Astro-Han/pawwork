import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { answersForQuestionText, deliveryConfig, Engine, questionPrompt } from "./engine.ts"
import { SessionPointers } from "./session-pointers.ts"
import type {
  Message,
  PendingPermission,
  PendingQuestion,
  PermissionReply,
  Platform,
  Question,
  Session,
  Sidecar,
} from "./types.ts"

// Zero the delivery backoff for the whole file so retry paths run instantly.
let savedBackoff = 0
beforeAll(() => {
  savedBackoff = deliveryConfig.backoffMs
  deliveryConfig.backoffMs = 0
})
afterAll(() => {
  deliveryConfig.backoffMs = savedBackoff
})

class FakeSidecar implements Sidecar {
  created: string[] = []
  prompts: { sessionID: string; text: string }[] = []
  sessions: Session[] = []
  permissionReplies: { pending: PendingPermission; reply: PermissionReply }[] = []
  questionReplies: { pending: PendingQuestion; answers: string[][] }[] = []
  aborted = false

  async createSession(): Promise<string> {
    const id = this.created.length > 0 ? "ses_new_2" : "ses_new"
    this.created.push(id)
    return id
  }
  async sendPrompt(sessionID: string, text: string): Promise<void> {
    this.prompts.push({ sessionID, text })
  }
  async listSessions(): Promise<Session[]> {
    return this.sessions
  }
  async abortSession(): Promise<boolean> {
    return this.aborted
  }
  async replyPermission(pending: PendingPermission, reply: PermissionReply): Promise<void> {
    this.permissionReplies.push({ pending, reply })
  }
  async submitQuestion(pending: PendingQuestion, answers: string[][]): Promise<void> {
    this.questionReplies.push({ pending, answers })
  }
}

class FakePlatform implements Platform {
  replies: string[] = []
  sends: string[] = []
  reconstructKey = ""
  replyFailures = 0
  replyCalls = 0
  constructor(readonly name = "chat") {}

  async start(): Promise<void> {}
  async reply(_replyCtx: unknown, content: string): Promise<void> {
    this.replyCalls++
    if (this.replyFailures > 0) {
      this.replyFailures--
      throw new Error("transient delivery failure")
    }
    this.replies.push(content)
  }
  async send(_replyCtx: unknown, content: string): Promise<void> {
    this.sends.push(content)
  }
  reconstructReplyCtx(remoteKey: string): unknown {
    this.reconstructKey = remoteKey
    return "restored-reply-context"
  }
  async stop(): Promise<void> {}
}

// --- builders (TS interfaces require all fields; Go used zero-value literals) ---

function perm(p: Partial<PendingPermission> & { sessionID: string }): PendingPermission {
  return {
    id: p.id ?? "",
    sessionID: p.sessionID,
    permission: p.permission ?? "",
    patterns: p.patterns ?? [],
    directory: p.directory ?? "",
  }
}

function pendingQuestion(q: Partial<PendingQuestion> & { sessionID: string }): PendingQuestion {
  return {
    sessionID: q.sessionID,
    messageID: q.messageID ?? "",
    callID: q.callID ?? "",
    questions: q.questions ?? [],
    directory: q.directory ?? "",
  }
}

function question(text: string, opts: { header?: string; multiple?: boolean; options?: [string, string?][] } = {}): Question {
  return {
    header: opts.header ?? "",
    question: text,
    multiple: opts.multiple ?? false,
    options: (opts.options ?? []).map(([label, description]) => ({ label, description: description ?? "" })),
  }
}

function sessionInfo(s: Partial<Session> & { id: string }): Session {
  return { id: s.id, title: s.title ?? "", parentID: s.parentID ?? "", directory: s.directory ?? "" }
}

async function tempStatePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rb-engine-"))
  return join(dir, "sessions.json")
}

const lastReply = (platform: FakePlatform) => platform.replies[platform.replies.length - 1]

test("starts and continues the current session", async () => {
  const sidecar = new FakeSidecar()
  const platform = new FakePlatform()
  const engine = new Engine(sidecar)
  const msg: Message = { sessionKey: "feishu:chat:alice", content: "/new" }

  await engine.handleMessage(platform, msg)
  expect(sidecar.created).toHaveLength(1)

  msg.content = "continue this"
  await engine.handleMessage(platform, msg)
  expect(sidecar.prompts).toEqual([{ sessionID: "ses_new", text: "continue this" }])
})

test("replies to events after a /new command", async () => {
  const sidecar = new FakeSidecar()
  const platform = new FakePlatform()
  const engine = new Engine(sidecar)
  await engine.handleMessage(platform, { sessionKey: "feishu:chat:alice", content: "/new", replyCtx: "reply-ctx" })

  await engine.handleAssistantText("ses_new", "new session is ready")
  expect(lastReply(platform)).toBe("new session is ready")
})

test("sends unknown slash text as a prompt", async () => {
  const sidecar = new FakeSidecar()
  const platform = new FakePlatform()
  const engine = new Engine(sidecar)
  await engine.handleMessage(platform, { sessionKey: "slack:dm:alice", content: "/src/main.go" })

  expect(sidecar.prompts).toEqual([{ sessionID: "ses_new", text: "/src/main.go" }])
  expect(platform.replies).toHaveLength(0)
})

test("lists and switches recent sessions", async () => {
  const sidecar = new FakeSidecar()
  sidecar.sessions = [sessionInfo({ id: "ses_a", title: "Plan launch" }), sessionInfo({ id: "ses_b", title: "Fix importer" })]
  const platform = new FakePlatform()
  const engine = new Engine(sidecar)
  const msg: Message = { sessionKey: "slack:dm:bob", content: "/sessions" }

  await engine.handleMessage(platform, msg)
  expect(platform.replies).toEqual(["Recent PawWork sessions:\n1. Plan launch\n2. Fix importer\n\nSwitch with /sessions 2."])

  msg.content = "/sessions 2"
  await engine.handleMessage(platform, msg)
  expect(engine.currentSession("slack:dm:bob")).toBe("ses_b")

  msg.content = "use this session"
  await engine.handleMessage(platform, msg)
  expect(sidecar.prompts[0]).toEqual({ sessionID: "ses_b", text: "use this session" })
})

test("switch resolves against the current session list, not a stale picker", async () => {
  const sidecar = new FakeSidecar()
  sidecar.sessions = [sessionInfo({ id: "ses_a", title: "Plan launch" }), sessionInfo({ id: "ses_b", title: "Fix importer" })]
  const platform = new FakePlatform()
  const engine = new Engine(sidecar)
  const msg: Message = { sessionKey: "slack:dm:bob", content: "/sessions" }
  await engine.handleMessage(platform, msg)

  sidecar.sessions = [sessionInfo({ id: "ses_c", title: "Triage bug" }), sessionInfo({ id: "ses_d", title: "Write docs" })]

  msg.content = "/sessions 2"
  await engine.handleMessage(platform, msg)
  expect(engine.currentSession("slack:dm:bob")).toBe("ses_d")
})

test("rejects switching to a child of another remote root", async () => {
  const sidecar = new FakeSidecar()
  sidecar.sessions = [sessionInfo({ id: "ses_root", title: "Root" }), sessionInfo({ id: "ses_child", title: "Child", parentID: "ses_root" })]
  const engine = new Engine(sidecar)

  const slack = new FakePlatform("slack")
  const slackMsg: Message = { sessionKey: "slack:dm:alice", content: "/sessions" }
  await engine.handleMessage(slack, slackMsg)
  slackMsg.content = "/sessions 1"
  await engine.handleMessage(slack, slackMsg)

  const feishu = new FakePlatform("feishu")
  const feishuMsg: Message = { sessionKey: "feishu:chat:ops", content: "/sessions" }
  await engine.handleMessage(feishu, feishuMsg)
  feishuMsg.content = "/sessions 2"
  await expect(engine.handleMessage(feishu, feishuMsg)).rejects.toThrow()

  expect(engine.currentSession("feishu:chat:ops")).toBe("")
  expect(lastReply(feishu)).toBe(
    "PawWork could not remember the session: session root is already bound to another remote conversation",
  )
})

test("replies to events after switching sessions", async () => {
  const sidecar = new FakeSidecar()
  sidecar.sessions = [sessionInfo({ id: "ses_a", title: "Plan launch" }), sessionInfo({ id: "ses_b", title: "Fix importer" })]
  const platform = new FakePlatform()
  const engine = new Engine(sidecar)
  const msg: Message = { sessionKey: "slack:dm:bob", content: "/sessions" }
  await engine.handleMessage(platform, msg)
  msg.content = "/sessions 2"
  msg.replyCtx = "switch-reply-ctx"
  await engine.handleMessage(platform, msg)

  await engine.handleAssistantText("ses_b", "switched session completed")
  expect(lastReply(platform)).toBe("switched session completed")
})

test("routes a pending permission reply before treating it as a prompt", async () => {
  const sidecar = new FakeSidecar()
  const platform = new FakePlatform()
  const engine = new Engine(sidecar)
  const msg: Message = { sessionKey: "weixin:user:alice", content: "/new" }
  await engine.handleMessage(platform, msg)

  await engine.handlePermission(perm({ id: "perm_1", sessionID: "ses_new", permission: "edit", patterns: ["/repo/app.ts"] }))

  msg.content = "yes"
  await engine.handleMessage(platform, msg)

  expect(sidecar.permissionReplies).toHaveLength(1)
  const reply = sidecar.permissionReplies[0]
  expect(reply.pending.id).toBe("perm_1")
  expect(reply.pending.patterns).toEqual(["/repo/app.ts"])
  expect(reply.reply).toEqual({ reply: "once", message: "" })
  expect(sidecar.prompts).toHaveLength(0)
})

test("routes a pending question answer before treating it as a prompt", async () => {
  const sidecar = new FakeSidecar()
  const platform = new FakePlatform()
  const engine = new Engine(sidecar)
  const msg: Message = { sessionKey: "slack:dm:alice", content: "/new" }
  await engine.handleMessage(platform, msg)

  await engine.handleQuestion(
    pendingQuestion({
      sessionID: "ses_new",
      messageID: "msg_1",
      callID: "call_1",
      questions: [question("Pick one", { options: [["A"], ["B"]] })],
    }),
  )

  msg.content = "2"
  await engine.handleMessage(platform, msg)

  expect(sidecar.questionReplies).toHaveLength(1)
  expect(sidecar.questionReplies[0].pending.callID).toBe("call_1")
  expect(sidecar.questionReplies[0].answers).toEqual([["B"]])
  expect(sidecar.prompts).toHaveLength(0)
})

test("stops the current run", async () => {
  const sidecar = new FakeSidecar()
  sidecar.aborted = true
  const platform = new FakePlatform()
  const engine = new Engine(sidecar)
  const msg: Message = { sessionKey: "telegram:alice", content: "/new" }
  await engine.handleMessage(platform, msg)

  msg.content = "/stop"
  await engine.handleMessage(platform, msg)
  expect(lastReply(platform)).toBe("Stopped the current PawWork run.")
})

test("persists the current session pointer across restarts", async () => {
  const path = await tempStatePath()
  const store = await SessionPointers.fromFile(path)
  const platform = new FakePlatform()
  const engine = new Engine(new FakeSidecar(), store)
  const msg: Message = { sessionKey: "feishu:chat:alice", content: "/new" }
  await engine.handleMessage(platform, msg)

  const reloaded = await SessionPointers.fromFile(path)
  const sidecar = new FakeSidecar()
  const restarted = new Engine(sidecar, reloaded)
  msg.content = "continue here"
  await restarted.handleMessage(platform, msg)

  expect(sidecar.created).toHaveLength(0)
  expect(sidecar.prompts).toEqual([{ sessionID: "ses_new", text: "continue here" }])
})

test("replies to events on the active conversation", async () => {
  const sidecar = new FakeSidecar()
  const platform = new FakePlatform()
  const engine = new Engine(sidecar)
  await engine.handleMessage(platform, { sessionKey: "slack:dm:alice", content: "what changed?" })

  await engine.handleAssistantText("ses_new", "A small fix landed.")
  expect(lastReply(platform)).toBe("A small fix landed.")
})

test("restores the reply target after a restart", async () => {
  const path = await tempStatePath()
  const store = await SessionPointers.fromFile(path)
  const firstEngine = new Engine(new FakeSidecar(), store)
  await firstEngine.handleMessage(new FakePlatform("slack"), { sessionKey: "slack:dm:alice", content: "start work" })

  const reloaded = await SessionPointers.fromFile(path)
  const platform = new FakePlatform("slack")
  const secondEngine = new Engine(new FakeSidecar(), reloaded)
  secondEngine.registerPlatform(platform)
  await secondEngine.handleAssistantText("ses_new", "finished after restart")

  expect(platform.reconstructKey).toBe("slack:dm:alice")
  expect(platform.sends).toEqual(["finished after restart"])
  expect(platform.replies).toHaveLength(0)
})

test("surfaces a pending permission and answers it", async () => {
  const sidecar = new FakeSidecar()
  const platform = new FakePlatform()
  const engine = new Engine(sidecar)
  const msg: Message = { sessionKey: "weixin:user:alice", content: "edit the file" }
  await engine.handleMessage(platform, msg)

  await engine.handlePermission(perm({ id: "perm_1", sessionID: "ses_new", permission: "edit", patterns: ["/repo/app.ts"] }))
  expect(lastReply(platform)).toBe("PawWork asks permission: edit\n/repo/app.ts\n\nReply yes, always, or no.")

  msg.content = "always"
  await engine.handleMessage(platform, msg)
  expect(sidecar.permissionReplies[0].reply.reply).toBe("always")
})

test("routes a child session permission through the root conversation", async () => {
  const sidecar = new FakeSidecar()
  const platform = new FakePlatform()
  const engine = new Engine(sidecar)
  const msg: Message = { sessionKey: "slack:dm:alice", content: "delegate this" }
  await engine.handleMessage(platform, msg)
  await engine.registerSession(sessionInfo({ id: "child_1", parentID: "ses_new" }))

  await engine.handlePermission(perm({ id: "perm_child", sessionID: "child_1", permission: "edit", patterns: ["/repo/child.ts"] }))
  expect(lastReply(platform)).toBe("PawWork asks permission: edit\n/repo/child.ts\n\nReply yes, always, or no.")

  msg.content = "yes"
  await engine.handleMessage(platform, msg)
  expect(sidecar.permissionReplies).toHaveLength(1)
  expect(sidecar.permissionReplies[0].pending.id).toBe("perm_child")
  expect(sidecar.prompts).toHaveLength(1)

  msg.content = "continue after permission"
  await engine.handleMessage(platform, msg)
  expect(sidecar.prompts).toHaveLength(2)
  expect(sidecar.prompts[1]).toEqual({ sessionID: "ses_new", text: "continue after permission" })
})

test("answers pending permissions in arrival order, one at a time", async () => {
  const sidecar = new FakeSidecar()
  const platform = new FakePlatform()
  const engine = new Engine(sidecar)
  const msg: Message = { sessionKey: "slack:dm:alice", content: "start" }
  await engine.handleMessage(platform, msg)

  for (const permission of [
    perm({ id: "perm_first", sessionID: "ses_new", permission: "edit", patterns: ["/repo/a.ts"] }),
    perm({ id: "perm_second", sessionID: "ses_new", permission: "edit", patterns: ["/repo/b.ts"] }),
  ]) {
    await engine.handlePermission(permission)
  }

  expect(platform.replies).toHaveLength(1)
  expect(platform.replies[0]).toContain("/repo/a.ts")

  msg.content = "yes"
  await engine.handleMessage(platform, msg)
  expect(platform.replies).toHaveLength(2)
  expect(platform.replies[1]).toContain("/repo/b.ts")

  msg.content = "no"
  await engine.handleMessage(platform, msg)

  expect(sidecar.permissionReplies).toHaveLength(2)
  expect(sidecar.permissionReplies[0].pending.id).toBe("perm_first")
  expect(sidecar.permissionReplies[1].pending.id).toBe("perm_second")
})

test("restores child session delivery after a restart", async () => {
  const path = await tempStatePath()
  const store = await SessionPointers.fromFile(path)
  await store.set("slack:dm:alice", "ses_root")
  await store.setParent("ses_child", "ses_root")

  const reloaded = await SessionPointers.fromFile(path)
  const platform = new FakePlatform("slack")
  const engine = new Engine(new FakeSidecar(), reloaded)
  engine.registerPlatform(platform)
  await engine.handleAssistantText("ses_child", "child completed")

  expect(platform.reconstructKey).toBe("slack:dm:alice")
  expect(platform.sends).toEqual(["child completed"])
})

test("surfaces a pending question with formatted options", async () => {
  const sidecar = new FakeSidecar()
  const platform = new FakePlatform()
  const engine = new Engine(sidecar)
  await engine.handleMessage(platform, { sessionKey: "feishu:chat:alice", content: "plan it" })

  await engine.handleQuestion(
    pendingQuestion({
      sessionID: "ses_new",
      messageID: "msg_1",
      callID: "call_1",
      questions: [question("Which path should I take?", { header: "Approach", options: [["A", "Small change"], ["B", "Larger cleanup"]] })],
    }),
  )

  expect(lastReply(platform)).toBe(
    "Approach\nWhich path should I take?\n1. A - Small change\n2. B - Larger cleanup\n\nReply with a number or answer text.",
  )
})

test("maps multi-select numbers to option labels", async () => {
  const sidecar = new FakeSidecar()
  const platform = new FakePlatform()
  const engine = new Engine(sidecar)
  const msg: Message = { sessionKey: "feishu:chat:alice", content: "choose" }
  await engine.handleMessage(platform, msg)

  await engine.handleQuestion(
    pendingQuestion({
      sessionID: "ses_new",
      messageID: "msg_1",
      callID: "call_1",
      questions: [question("Pick several", { multiple: true, options: [["A"], ["B"], ["C"]] })],
    }),
  )

  msg.content = "1, 3"
  await engine.handleMessage(platform, msg)
  expect(sidecar.questionReplies).toHaveLength(1)
  expect(sidecar.questionReplies[0].answers).toEqual([["A", "C"]])
})

test("assistant text retries a transient delivery failure, then gives up bounded", async () => {
  // Recovers when the platform fails transiently, then succeeds.
  const recovers = new FakePlatform()
  recovers.replyFailures = deliveryConfig.attempts - 1
  const engine = new Engine(new FakeSidecar())
  await engine.handleMessage(recovers, { sessionKey: "slack:dm:a", content: "hi" })
  await engine.handleAssistantText("ses_new", "answer")
  expect(recovers.replyCalls).toBe(deliveryConfig.attempts)
  expect(recovers.replies).toEqual(["answer"])

  // Gives up after a bounded number of attempts — never holds the cursor.
  const keepsFailing = new FakePlatform()
  keepsFailing.replyFailures = deliveryConfig.attempts + 5
  const engine2 = new Engine(new FakeSidecar())
  await engine2.handleMessage(keepsFailing, { sessionKey: "slack:dm:b", content: "hi" })
  await expect(engine2.handleAssistantText("ses_new", "answer")).rejects.toThrow()
  expect(keepsFailing.replyCalls).toBe(deliveryConfig.attempts)
})

test("permission and question prompts retry a transient delivery failure", async () => {
  const permPlatform = new FakePlatform()
  permPlatform.replyFailures = deliveryConfig.attempts - 1
  const permEngine = new Engine(new FakeSidecar())
  await permEngine.handleMessage(permPlatform, { sessionKey: "slack:dm:a", content: "hi" })
  await permEngine.handlePermission(perm({ id: "perm_1", sessionID: "ses_new", permission: "edit", patterns: ["/repo/app.ts"] }))
  expect(permPlatform.replyCalls).toBe(deliveryConfig.attempts)
  expect(permPlatform.replies).toHaveLength(1)

  const questionPlatform = new FakePlatform()
  questionPlatform.replyFailures = deliveryConfig.attempts + 5
  const questionEngine = new Engine(new FakeSidecar())
  await questionEngine.handleMessage(questionPlatform, { sessionKey: "slack:dm:b", content: "hi" })
  await expect(
    questionEngine.handleQuestion(
      pendingQuestion({ sessionID: "ses_new", messageID: "msg_1", questions: [question("Pick one", { options: [["A"], ["B"]] })] }),
    ),
  ).rejects.toThrow()
  expect(questionPlatform.replyCalls).toBe(deliveryConfig.attempts)
})

test("an undelivered prompt does not intercept the next message", async () => {
  const sidecar = new FakeSidecar()
  // Delivery keeps failing across the initial surface and the re-surface retry.
  const platform = new FakePlatform()
  platform.replyFailures = 100
  const engine = new Engine(sidecar)
  const msg: Message = { sessionKey: "slack:dm:a", content: "edit the file" }
  await engine.handleMessage(platform, msg)
  await expect(
    engine.handlePermission(perm({ id: "perm_1", sessionID: "ses_new", permission: "edit", patterns: ["/repo/app.ts"] })),
  ).rejects.toThrow()

  msg.content = "what is the weather"
  await engine.handleMessage(platform, msg)
  expect(sidecar.permissionReplies).toHaveLength(0)
  expect(sidecar.prompts).toHaveLength(2)
  expect(sidecar.prompts[1].text).toBe("what is the weather")
})

test("a failed next blocker is kept and re-surfaced on recovery (permission)", async () => {
  const sidecar = new FakeSidecar()
  const platform = new FakePlatform()
  const engine = new Engine(sidecar)
  const msg: Message = { sessionKey: "slack:dm:a", content: "start" }
  await engine.handleMessage(platform, msg)
  for (const permission of [
    perm({ id: "perm_first", sessionID: "ses_new", permission: "edit", patterns: ["/repo/a.ts"] }),
    perm({ id: "perm_second", sessionID: "ses_new", permission: "edit", patterns: ["/repo/b.ts"] }),
  ]) {
    await engine.handlePermission(permission)
  }
  expect(platform.replies).toHaveLength(1)

  // Answering the first surfaces the second, whose delivery now fails.
  platform.replyFailures = deliveryConfig.attempts
  msg.content = "yes"
  await expect(engine.handleMessage(platform, msg)).rejects.toThrow()
  expect(sidecar.permissionReplies).toHaveLength(1)
  expect(sidecar.permissionReplies[0].pending.id).toBe("perm_first")

  // On recovery the next ordinary message re-shows the kept prompt and is itself forwarded.
  platform.replyFailures = 0
  msg.content = "what is the weather"
  await engine.handleMessage(platform, msg)
  expect(platform.replies).toHaveLength(2)
  expect(platform.replies[1]).toContain("/repo/b.ts")
  expect(sidecar.permissionReplies).toHaveLength(1)
  expect(sidecar.prompts[sidecar.prompts.length - 1].text).toBe("what is the weather")

  // The re-shown second prompt is now answerable.
  msg.content = "no"
  await engine.handleMessage(platform, msg)
  expect(sidecar.permissionReplies).toHaveLength(2)
  expect(sidecar.permissionReplies[1].pending.id).toBe("perm_second")
})

test("a failed next blocker is kept and re-surfaced on recovery (question)", async () => {
  const sidecar = new FakeSidecar()
  const platform = new FakePlatform()
  const engine = new Engine(sidecar)
  const msg: Message = { sessionKey: "slack:dm:b", content: "start" }
  await engine.handleMessage(platform, msg)
  for (const q of [
    pendingQuestion({ sessionID: "ses_new", messageID: "msg_first", callID: "call_first", questions: [question("Pick one", { options: [["A"], ["B"]] })] }),
    pendingQuestion({ sessionID: "ses_new", messageID: "msg_second", callID: "call_second", questions: [question("Pick two", { options: [["C"], ["D"]] })] }),
  ]) {
    await engine.handleQuestion(q)
  }
  expect(platform.replies).toHaveLength(1)

  platform.replyFailures = deliveryConfig.attempts
  msg.content = "1"
  await expect(engine.handleMessage(platform, msg)).rejects.toThrow()
  expect(sidecar.questionReplies).toHaveLength(1)
  expect(sidecar.questionReplies[0].pending.messageID).toBe("msg_first")

  platform.replyFailures = 0
  msg.content = "hello there"
  await engine.handleMessage(platform, msg)
  expect(platform.replies).toHaveLength(2)
  expect(platform.replies[1]).toContain("Pick two")
  expect(sidecar.questionReplies).toHaveLength(1)
  expect(sidecar.prompts[sidecar.prompts.length - 1].text).toBe("hello there")

  msg.content = "1"
  await engine.handleMessage(platform, msg)
  expect(sidecar.questionReplies).toHaveLength(2)
  expect(sidecar.questionReplies[1].pending.messageID).toBe("msg_second")
})

test("question prompt hints match the question type", () => {
  const single = questionPrompt(pendingQuestion({ sessionID: "s", questions: [question("Pick one", { options: [["A"], ["B"]] })] }))
  expect(single.endsWith("Reply with a number or answer text.")).toBe(true)

  const multiSelect = questionPrompt(
    pendingQuestion({ sessionID: "s", questions: [question("Pick several", { multiple: true, options: [["A"], ["B"]] })] }),
  )
  expect(multiSelect).toContain("separated by commas")

  const multiQuestion = questionPrompt(pendingQuestion({ sessionID: "s", questions: [question("First?"), question("Second?")] }))
  expect(multiQuestion).toContain("one line per question")
})

test("multi-select accepts full-width and ideographic commas", () => {
  const pending = pendingQuestion({ sessionID: "s", questions: [question("", { multiple: true, options: [["A"], ["B"], ["C"]] })] })
  for (const input of ["1,3", "1，3", "1、3", "1， 3"]) {
    expect(answersForQuestionText(pending, input)).toEqual([["A", "C"]])
  }
})

test("answers pending questions in arrival order, one at a time", async () => {
  const sidecar = new FakeSidecar()
  const platform = new FakePlatform()
  const engine = new Engine(sidecar)
  const msg: Message = { sessionKey: "slack:dm:alice", content: "start" }
  await engine.handleMessage(platform, msg)
  for (const q of [
    pendingQuestion({ sessionID: "ses_new", messageID: "msg_1", callID: "call_1", questions: [question("First?", { options: [["A"], ["B"]] })] }),
    pendingQuestion({ sessionID: "ses_new", messageID: "msg_2", callID: "call_2", questions: [question("Second?", { options: [["C"], ["D"]] })] }),
  ]) {
    await engine.handleQuestion(q)
  }

  expect(platform.replies).toHaveLength(1)
  expect(platform.replies[0]).toContain("First?")

  msg.content = "1"
  await engine.handleMessage(platform, msg)
  expect(platform.replies).toHaveLength(2)
  expect(platform.replies[1]).toContain("Second?")

  msg.content = "2"
  await engine.handleMessage(platform, msg)

  expect(sidecar.questionReplies).toHaveLength(2)
  expect(sidecar.questionReplies[0].pending.callID).toBe("call_1")
  expect(sidecar.questionReplies[0].answers[0][0]).toBe("A")
  expect(sidecar.questionReplies[1].pending.callID).toBe("call_2")
  expect(sidecar.questionReplies[1].answers[0][0]).toBe("D")
})

test("surfaces interleaved blockers one at a time", async () => {
  const sidecar = new FakeSidecar()
  const platform = new FakePlatform()
  const engine = new Engine(sidecar)
  const msg: Message = { sessionKey: "slack:dm:alice", content: "start" }
  await engine.handleMessage(platform, msg)

  await engine.handlePermission(perm({ id: "perm_1", sessionID: "ses_new", permission: "edit", patterns: ["/repo/app.ts"] }))
  await engine.handleQuestion(
    pendingQuestion({ sessionID: "ses_new", messageID: "msg_1", callID: "call_1", questions: [question("Pick one", { options: [["A"], ["B"]] })] }),
  )
  expect(platform.replies).toHaveLength(1)
  expect(platform.replies[0]).toContain("asks permission")

  msg.content = "yes"
  await engine.handleMessage(platform, msg)
  expect(sidecar.permissionReplies).toHaveLength(1)
  expect(sidecar.permissionReplies[0].pending.id).toBe("perm_1")
  expect(sidecar.questionReplies).toHaveLength(0)
  expect(platform.replies).toHaveLength(2)
  expect(platform.replies[1]).toContain("Pick one")

  msg.content = "2"
  await engine.handleMessage(platform, msg)
  expect(sidecar.questionReplies).toHaveLength(1)
  expect(sidecar.questionReplies[0].answers[0][0]).toBe("B")
})

test("clears a permission resolved outside the remote", async () => {
  const sidecar = new FakeSidecar()
  const platform = new FakePlatform()
  const engine = new Engine(sidecar)
  const msg: Message = { sessionKey: "slack:dm:alice", content: "start" }
  await engine.handleMessage(platform, msg)
  await engine.handlePermission(perm({ id: "perm_1", sessionID: "ses_new", permission: "edit", patterns: ["/repo/app.ts"] }))

  await engine.handlePermissionResolved({ sessionID: "ses_new", requestID: "perm_1", directory: "" })
  msg.content = "continue after desktop reply"
  await engine.handleMessage(platform, msg)

  expect(sidecar.prompts).toHaveLength(2)
  expect(sidecar.prompts[1]).toEqual({ sessionID: "ses_new", text: "continue after desktop reply" })
})

test("clears a question resolved outside the remote", async () => {
  const sidecar = new FakeSidecar()
  const platform = new FakePlatform()
  const engine = new Engine(sidecar)
  const msg: Message = { sessionKey: "slack:dm:alice", content: "start" }
  await engine.handleMessage(platform, msg)
  await engine.handleQuestion(
    pendingQuestion({ sessionID: "ses_new", messageID: "msg_1", callID: "call_1", questions: [question("Pick one", { options: [["A"], ["B"]] })] }),
  )

  await engine.handleQuestionResolved({ sessionID: "ses_new", messageID: "msg_1", callID: "call_1", directory: "" })
  msg.content = "continue after desktop answer"
  await engine.handleMessage(platform, msg)

  expect(sidecar.prompts).toHaveLength(2)
  expect(sidecar.prompts[1]).toEqual({ sessionID: "ses_new", text: "continue after desktop answer" })
})
