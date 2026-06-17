// User-facing copy for the chat protocol, in the paired user's language. This is
// a personal companion — one paired user — so the bridge renders everything in a
// single locale (the desktop UI language), not per-message. Plain tables + a tiny
// t(): no i18n framework for ~25 strings. English keeps the product name
// "PawWork"; Chinese uses "爪印" (the app's localized name) and drops it where
// chat context already makes the sender obvious (command replies), keeping it only
// where a sentence needs a subject (permission / question / errors).

export type Locale = "en" | "zh"

const en = {
  "permission.title": "PawWork needs your permission:",
  "permission.replyHint": "Reply yes (allow once), always (always allow), or no (deny).",
  "permission.notUnderstoodPrefix": "Sorry, I didn't catch that. ",
  "question.fallback": "PawWork has a question.\n\nReply with your answer.",
  "question.label": "Question {n}:",
  "hint.single": "Reply with the number of your choice.",
  "hint.singleMulti": "Reply with the numbers you want, separated by commas (e.g. 1,3).",
  "hint.multiQuestion": "Answer each question on its own line, in order.",
  "hint.multiQuestionMulti":
    "Answer each question on its own line, in order. For a multiple-choice question, separate your picks with commas (e.g. 1,3).",
  "answers.lineMismatch": "There are {n} questions — reply with {n} lines, one answer per question.",
  "cmd.newSession": "Started a new PawWork session.",
  "cmd.noActiveSession": "No active PawWork session.",
  "cmd.stopped": "Stopped the current PawWork run.",
  "cmd.noRunning": "No running PawWork run.",
  "cmd.help": "Commands: /new, /sessions, /sessions N, /stop.",
  "cmd.recentSessions": "Recent PawWork sessions:",
  "cmd.switchHint": "Switch with /sessions 2.",
  "cmd.chooseHint": "Choose a session with /sessions 1.",
  "cmd.onlyN": "Only {n} recent PawWork sessions are available.",
  "cmd.switchedTo": "Switched to {x}.",
  "cmd.noRecent": "No recent PawWork sessions.",
  "err.startSession": "PawWork could not start a session: ",
  "err.sendMessage": "PawWork could not send the message: ",
  "err.answerPermission": "PawWork could not answer the permission request: ",
  "err.submitAnswer": "PawWork could not submit the answer: ",
  "err.stopRun": "PawWork could not stop the run: ",
  "err.listSessions": "PawWork could not list sessions: ",
  "err.rememberSession": "PawWork could not remember the session: ",
} as const

export type MessageKey = keyof typeof en

const zh: Record<MessageKey, string> = {
  "permission.title": "爪印需要你的许可：",
  "permission.replyHint": "回复“是”允许一次、“总是”始终允许、“否”拒绝。",
  "permission.notUnderstoodPrefix": "没看懂你的回复。",
  "question.fallback": "爪印向你提问。\n\n直接回复你的答案。",
  "question.label": "问题 {n}：",
  "hint.single": "回复选项编号即可。",
  "hint.singleMulti": "回复你选的编号，用逗号隔开（如 1,3）。",
  "hint.multiQuestion": "每个问题回复一行，按顺序作答。",
  "hint.multiQuestionMulti": "每个问题回复一行，按顺序作答。多选问题用逗号隔开（如 1,3）。",
  "answers.lineMismatch": "共 {n} 个问题，请回复 {n} 行，每行一个答案。",
  "cmd.newSession": "已新建会话。",
  "cmd.noActiveSession": "没有进行中的会话。",
  "cmd.stopped": "已停止当前运行。",
  "cmd.noRunning": "没有正在运行的任务。",
  "cmd.help": "命令：/new 新建会话，/sessions 查看会话，/sessions N 切换会话，/stop 停止运行。",
  "cmd.recentSessions": "近期会话：",
  "cmd.switchHint": "用 /sessions 2 切换会话。",
  "cmd.chooseHint": "用 /sessions 1 选择会话。",
  "cmd.onlyN": "仅有 {n} 个近期会话。",
  "cmd.switchedTo": "已切换到 {x}。",
  "cmd.noRecent": "没有近期会话。",
  "err.startSession": "爪印无法启动会话：",
  "err.sendMessage": "爪印无法发送消息：",
  "err.answerPermission": "爪印无法回应权限请求：",
  "err.submitAnswer": "爪印无法提交答案：",
  "err.stopRun": "爪印无法停止运行：",
  "err.listSessions": "爪印无法列出会话：",
  "err.rememberSession": "爪印无法记住会话：",
}

const tables: Record<Locale, Record<MessageKey, string>> = { en, zh }

/** Render a message in `locale`, substituting `{name}` placeholders. Falls back to
 * English for an unknown locale or a missing key, so a copy gap degrades to English
 * rather than showing a raw key. */
export function t(locale: Locale, key: MessageKey, params?: Record<string, string | number>): string {
  let text = (tables[locale] ?? en)[key] ?? en[key]
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
  }
  return text
}

/** Coerce any config value to a supported locale, defaulting to English. */
export function normalizeLocale(value: unknown): Locale {
  return value === "zh" ? "zh" : "en"
}
