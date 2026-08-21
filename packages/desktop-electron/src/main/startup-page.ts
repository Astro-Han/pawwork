import type { MenuLocale } from "./menu-labels"
import { startupPageLabels, type StartupFailureReason } from "./startup-page-labels"

// A private scheme rather than a file:// page or a data: URL: the page has a
// stable origin the navigation guard can name, its markup never has to exist on
// disk, and every reload re-runs the handler, so re-rendering a new state is a
// reload rather than a second window.
export const STARTUP_SCHEME = "pawwork-startup"
export const STARTUP_URL = `${STARTUP_SCHEME}://startup/`

export type StartupAction = "retry" | "report-issue" | "show-log" | "copy-details"

const ACTIONS: readonly StartupAction[] = ["retry", "report-issue", "show-log", "copy-details"]

export type StartupPageTarget = { kind: "page" } | { kind: "action"; action: StartupAction }

/**
 * What a navigation to this page's own origin is asking for.
 *
 * The page carries no script — the buttons are links back into this origin, and
 * the main frame guard turns them into main-process calls. Anything else on the
 * origin is not ours to act on, so it reads as a plain page load.
 * @param target - the URL the renderer wants to navigate to.
 * @returns the page, the action it names, or undefined when it is not our origin.
 */
export function startupPageTarget(target: string): StartupPageTarget | undefined {
  let url: URL
  try {
    url = new URL(target)
  } catch {
    return undefined
  }
  if (url.protocol !== `${STARTUP_SCHEME}:` || `${url.protocol}//${url.host}/` !== STARTUP_URL) return undefined
  const action = ACTIONS.find((candidate) => url.pathname === `/${candidate}`)
  return action ? { kind: "action", action } : { kind: "page" }
}

export type StartupPageState =
  | { phase: "starting" }
  | {
      phase: "failed"
      reason: StartupFailureReason
      diagnosis: string
      output: string
      logPath: string
      copied: boolean
    }

// A sentence, not a stack: long enough for the runtime's own wording, short
// enough that the page stays one screenful above the fold.
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
export function diagnose(output: string) {
  let found = ""
  for (const line of output.split(/\r?\n/)) {
    const match = /[A-Za-z]*Error(?: \[[^\]]+\])?: (.+)$/.exec(line.trim())
    if (match) found = match[1].trim()
  }
  return truncate(found)
}

/**
 * The sentence to lead the failure page with.
 *
 * The runtime's own stderr wins when it has one, because it names the cause and
 * usually the fix. It has none when the child never ran at all — a spawn that
 * failed, or a readiness timeout on a silent process — and there the thrown
 * error is the only account of what happened.
 * @param error - whatever startup rejected with.
 * @param output - whatever the runtime wrote before exiting.
 * @returns one sentence, or "" when neither source said anything.
 */
export function startupDiagnosis(error: unknown, output: string) {
  return diagnose(output) || truncate(error instanceof Error ? error.message.trim() : String(error ?? "").trim())
}

function truncate(text: string) {
  return text.length > MAX_DIAGNOSIS_CHARS ? `${text.slice(0, MAX_DIAGNOSIS_CHARS)}…` : text
}

/**
 * The whole failure as plain text, for the details block and the clipboard.
 *
 * One function for both so the text the user reads is the text they paste into
 * an issue — the diagnosis included, because the sentence above it can be
 * truncated and a report that starts mid-word helps nobody.
 * @param state - the failed page state.
 * @param locale - which copy to label the log path with.
 * @returns the report text, never empty.
 */
export function startupFailureReport(state: Extract<StartupPageState, { phase: "failed" }>, locale: MenuLocale) {
  const copy = startupPageLabels(locale).details
  return [state.diagnosis, state.output.trim() || copy.noOutput, `${copy.logLabel}\n${state.logPath}`]
    .filter(Boolean)
    .join("\n\n")
}

function escapeHtml(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

function action(name: StartupAction, label: string, variant: "primary" | "secondary" | "link") {
  return `<a class="${variant}" href="${STARTUP_URL}${name}">${escapeHtml(label)}</a>`
}

const CSS = `
/* Same variable contract as the DSH surface: macOS gets the height from the
   host, Windows publishes its own through env(), Linux publishes neither and
   the fallback collapses the band. */
:root {
  --pawwork-titlebar-height: var(--pawwork-titlebar-host-height, env(titlebar-area-height, 0px));
  --bg: #ffffff;
  --fg: #16161a;
  --fg-dim: #6c6c74;
  --line: #e3e3e7;
  --surface: #f6f6f8;
  --accent: #fc5c14;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #191919; --fg: #f0f0f2; --fg-dim: #9b9ba3; --line: #2d2d31; --surface: #212124; }
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  background: var(--bg); color: var(--fg); margin: 0;
  display: flex; align-items: center; justify-content: center;
  font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  padding: calc(var(--pawwork-titlebar-height, 0px) + 32px) 32px 32px;
}
/* The band is the frameless window's only drag region; without it the window
   cannot be moved except by its edges. */
.titlebar {
  -webkit-app-region: drag;
  height: var(--pawwork-titlebar-height, 0px);
  left: 0; position: fixed; right: 0; top: 0;
}
main { max-width: 520px; width: 100%; }
h1 { font-size: 19px; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 6px; }
p { color: var(--fg-dim); margin: 0; }
.bar { background: var(--line); border-radius: 999px; height: 3px; margin-top: 20px; overflow: hidden; }
.bar span { background: var(--accent); border-radius: 999px; display: block; height: 100%; width: 40%; }
@media (prefers-reduced-motion: no-preference) {
  .bar span { animation: pawwork-startup-slide 1.6s cubic-bezier(0.4, 0, 0.2, 1) infinite; }
  @keyframes pawwork-startup-slide {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(250%); }
  }
}
.diagnosis {
  background: var(--surface); border: 1px solid var(--line); border-radius: 8px;
  font: 12.5px/1.6 ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  margin-top: 16px; overflow-wrap: anywhere; padding: 12px 14px; white-space: pre-wrap;
}
details { margin-top: 16px; }
summary { color: var(--fg-dim); cursor: default; font-size: 13px; width: fit-content; }
pre {
  background: var(--surface); border: 1px solid var(--line); border-radius: 8px; color: var(--fg-dim);
  font: 12px/1.55 ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  margin: 10px 0 0; max-height: 220px; overflow: auto; overflow-wrap: anywhere;
  padding: 12px 14px; white-space: pre-wrap;
}
.row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; }
.actions { margin-top: 20px; }
a { text-decoration: none; }
a.primary, a.secondary { border: 1px solid transparent; border-radius: 7px; font-size: 13px; font-weight: 500; padding: 7px 14px; }
a.primary { background: var(--accent); color: #ffffff; }
a.secondary { border-color: var(--line); color: var(--fg); }
a.secondary:hover { background: var(--surface); }
a.link { color: var(--fg-dim); font-size: 12.5px; }
a.link:hover { color: var(--fg); }
a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.copied { color: var(--fg-dim); font-size: 12.5px; }
`

/**
 * The whole startup surface as one self-contained document.
 *
 * No script and no external resource: the page's only interactions are links
 * back to its own origin, which the window turns into main-process calls, so
 * `default-src 'none'` holds and the failure text stays selectable markup
 * instead of a modal's uncopyable string.
 * @param locale - which copy to render.
 * @param state - what the runtime is doing, or what it did.
 * @returns a complete HTML document.
 */
export function startupPageHtml(locale: MenuLocale, state: StartupPageState) {
  const copy = startupPageLabels(locale)
  const body =
    state.phase === "starting"
      ? `<h1>${escapeHtml(copy.starting.title)}</h1>
      <p>${escapeHtml(copy.starting.message)}</p>
      <div class="bar" role="progressbar"><span></span></div>`
      : `<h1>${escapeHtml(copy.failed[state.reason].title)}</h1>
      <p>${escapeHtml(copy.failed[state.reason].message)}</p>
      ${state.diagnosis ? `<div class="diagnosis">${escapeHtml(state.diagnosis)}</div>` : ""}
      <details${state.copied ? " open" : ""}>
        <summary>${escapeHtml(copy.details.summary)}</summary>
        <pre>${escapeHtml(startupFailureReport(state, locale))}</pre>
        <div class="row">
          ${
            state.copied
              ? `<span class="copied">${escapeHtml(copy.actions.copied)}</span>`
              : action("copy-details", copy.actions.copyDetails, "link")
          }
          ${action("show-log", copy.actions.showLog, "link")}
        </div>
      </details>
      <div class="row actions">
        ${action("retry", copy.actions.retry, "primary")}
        ${action("report-issue", copy.actions.reportIssue, "secondary")}
      </div>`

  return `<!doctype html>
<html lang="${locale === "zh" ? "zh-CN" : "en"}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>PawWork</title>
<style>${CSS}</style>
</head>
<body>
<div class="titlebar"></div>
<main>${body}</main>
</body>
</html>
`
}
