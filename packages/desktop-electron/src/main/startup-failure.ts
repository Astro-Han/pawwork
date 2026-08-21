import type { MenuLocale } from "./menu-labels"

type Labels = {
  title: string
  message: string
  hint: (logPath: string) => string
  buttons: { quit: string; reportIssue: string; showLog: string }
}

const labels: Record<MenuLocale, Labels> = {
  en: {
    title: "PawWork Could Not Start",
    message: "PawWork's agent runtime did not start, so the app is closing.",
    hint: (logPath) => `The full log is at:\n${logPath}`,
    buttons: { quit: "Quit", reportIssue: "Report a Problem", showLog: "Show Log" },
  },
  zh: {
    title: "爪印无法启动",
    message: "爪印的智能体运行时未能启动，应用即将退出。",
    hint: (logPath) => `完整日志位于：\n${logPath}`,
    buttons: { quit: "退出", reportIssue: "反馈问题", showLog: "显示日志" },
  },
}

// A sentence, not a stack: long enough for the runtime's own wording, short
// enough that the dialog stays one screenful.
const MAX_DIAGNOSIS_CHARS = 400

/**
 * The one sentence worth showing out of a runtime's dying output.
 *
 * A runtime that fails loud prints a stack dump: the sentence naming the cause
 * and the fix sits at the top, wrapped in frames, and repeats down the `[cause]`
 * chain as each layer rethrows. The innermost repetition is the most specific,
 * so the last match wins, and the frames are noise nobody can act on.
 *
 * The bracket is optional because Node labels its own failures with a code —
 * `Error [ERR_MODULE_NOT_FOUND]: ...` is what a missing plugin package looks
 * like, and that is one of the failures most worth naming.
 * @param output - whatever the runtime wrote before exiting.
 * @returns the innermost error sentence, or "" if there is none.
 */
function diagnose(output: string) {
  let found = ""
  for (const line of output.split(/\r?\n/)) {
    const match = /[A-Za-z]*Error(?: \[[^\]]+\])?: (.+)$/.exec(line.trim())
    if (match) found = match[1].trim()
  }
  return found.length > MAX_DIAGNOSIS_CHARS ? `${found.slice(0, MAX_DIAGNOSIS_CHARS)}…` : found
}

function startupFailureDialog(locale: MenuLocale, logPath: string, output: string) {
  const copy = labels[locale]

  return {
    type: "error" as const,
    title: copy.title,
    message: copy.message,
    detail: [diagnose(output), copy.hint(logPath)].filter(Boolean).join("\n\n"),
    // Quit leads: it is what the app is about to do anyway, and it is the safe
    // landing spot for Return and Escape alike.
    buttons: [copy.buttons.quit, copy.buttons.reportIssue, copy.buttons.showLog],
    defaultId: 0,
    cancelId: 0,
  }
}

type ReportStartupFailureOptions = {
  locale: MenuLocale
  logPath: string
  output: string
  showMessageBox: (options: ReturnType<typeof startupFailureDialog>) => Promise<{ response: number }>
  openIssue: () => void | Promise<void>
  showItemInFolder: (path: string) => void | Promise<void>
}

/**
 * Tell the user why the app is closing, and offer the two ways out.
 *
 * Reporting comes before the log because the log is a dead end on its own: a
 * `.log` file has no owning app on a fresh machine, and the user who cannot fix
 * the runtime needs somewhere to hand the failure to. The menu that normally
 * carries that link is never built when the start fails this early.
 * @param options - locale, log path, the runtime's output, and the host calls.
 */
export async function reportStartupFailure(options: ReportStartupFailureOptions) {
  const content = startupFailureDialog(options.locale, options.logPath, options.output)
  const { response } = await options.showMessageBox(content)
  if (response === 1) await options.openIssue()
  if (response === 2) await options.showItemInFolder(options.logPath)
}
