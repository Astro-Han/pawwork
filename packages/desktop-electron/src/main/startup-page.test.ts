import { describe, expect, test } from "vitest"
import {
  STARTUP_URL,
  diagnose,
  startupDiagnosis,
  startupFailureReport,
  startupPageHtml,
  startupPageTarget,
  type StartupPageState,
} from "./startup-page"
import { startupPageLabels } from "./startup-page-labels"

const LOG_PATH = "/Users/pat/Library/Logs/PawWork/main.log"

// Reproduced from a real DSH exit: the sentence that says what to do is at the
// top, buried in frames, and repeated down the `[cause]` chain.
const CRASH_DUMP = `file:///app/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js:299
      throw new Error(\`failed to load plugin\`, { cause })
      ^

Error: failed to load plugin
    at updateError (file:///app/node_modules/@deepseek-ai/cordis-plugin-loader/lib/index.js:299:9)
    at Entry._init (file:///app/node_modules/@deepseek-ai/cordis/lib/index.js:519:10) {
  [cause]: Error: credentials-local: /Users/pat/.credentials.yaml is readable beyond its owner (mode 644); run "chmod 600 /Users/pat/.credentials.yaml" before starting again
      at assertOwnerOnly (file:///app/node_modules/@deepseek-ai/dsh-credentials-local/lib/index.js:104:8)
}

Node.js v26.7.0`

const CREDENTIALS_SENTENCE =
  'credentials-local: /Users/pat/.credentials.yaml is readable beyond its owner (mode 644); run "chmod 600 /Users/pat/.credentials.yaml" before starting again'

function failed(overrides: Partial<Extract<StartupPageState, { phase: "failed" }>> = {}) {
  return {
    phase: "failed",
    reason: "startup",
    diagnosis: CREDENTIALS_SENTENCE,
    output: CRASH_DUMP,
    logPath: LOG_PATH,
    copied: false,
    ...overrides,
  } satisfies Extract<StartupPageState, { phase: "failed" }>
}

describe("DSH failure diagnosis", () => {
  // The page's whole job is to hand back the runtime's own words. Anything the
  // user cannot act on — the throw site, the frames, the Node version — is noise
  // that pushes the one actionable sentence off the screen.
  test("reads the innermost cause of a stack dump and nothing else from it", () => {
    expect(diagnose(CRASH_DUMP)).toBe(CREDENTIALS_SENTENCE)
  })

  // Node labels its own failures with a code, and a plugin package that failed
  // to resolve is one of the failures most worth naming.
  test("reads through the bracketed code Node puts on its own errors", () => {
    expect(
      diagnose(
        [
          "node:internal/modules/esm/resolve:275",
          "  throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base))",
          "",
          "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@pawwork/dsh-product' imported from /Users/pat/.pawwork/",
          "    at packageResolve (node:internal/modules/esm/resolve:275:9)",
        ].join("\n"),
      ),
    ).toBe("Cannot find package '@pawwork/dsh-product' imported from /Users/pat/.pawwork/")
  })

  test("says nothing when the runtime said nothing recognisable", () => {
    expect(diagnose("dsh: starting\ndsh: loading plugins\n")).toBe("")
  })

  test("truncates a runtime that puts a whole document on one line", () => {
    const diagnosis = diagnose(`Error: ${"x".repeat(900)}`)

    expect(diagnosis).toHaveLength(401)
    expect(diagnosis.endsWith("…")).toBe(true)
  })

  // A spawn that fails and a readiness timeout both leave the runtime's own
  // output empty, and they are exactly the failures with no other account.
  test("falls back to the thrown error when the runtime never wrote anything", () => {
    expect(startupDiagnosis(new Error("DSH failed to start: spawn /app/PawWork EACCES"), "")).toBe(
      "DSH failed to start: spawn /app/PawWork EACCES",
    )
    expect(startupDiagnosis(new Error("DSH exited (code 1)"), CRASH_DUMP)).toBe(CREDENTIALS_SENTENCE)
    expect(startupDiagnosis(new Error(`x${"y".repeat(900)}`), "")).toHaveLength(401)
  })
})

describe("startup page", () => {
  test("routes only its own origin, and only the actions it defines", () => {
    expect(startupPageTarget(`${STARTUP_URL}retry`)).toEqual({ kind: "action", action: "retry" })
    expect(startupPageTarget(`${STARTUP_URL}show-log`)).toEqual({ kind: "action", action: "show-log" })
    expect(startupPageTarget(STARTUP_URL)).toEqual({ kind: "page" })
    expect(startupPageTarget(`${STARTUP_URL}quit`)).toEqual({ kind: "page" })
    // A look-alike host is a different origin, and so is a different scheme.
    expect(startupPageTarget("pawwork-startup://startup.evil.example/retry")).toBeUndefined()
    expect(startupPageTarget("https://startup/retry")).toBeUndefined()
    expect(startupPageTarget("not a url")).toBeUndefined()
  })

  // The text on screen is the text the user pastes into an issue, so it is one
  // string: the diagnosis included, because the sentence above it can be cut
  // short and a report that starts mid-word helps nobody.
  test("reports the diagnosis, the runtime's output and the log path as one block", () => {
    expect(startupFailureReport(failed(), "en")).toBe(
      `${CREDENTIALS_SENTENCE}\n\n${CRASH_DUMP}\n\nFull log:\n${LOG_PATH}`,
    )
    expect(startupFailureReport(failed({ diagnosis: "", output: "  \n" }), "zh")).toBe(
      `运行时在退出前没有任何输出。\n\n完整日志：\n${LOG_PATH}`,
    )
  })

  test("carries no script and reaches for nothing off the page", () => {
    const html = startupPageHtml("en", failed())

    expect(html).not.toMatch(/<script|\son[a-z]+=/i)
    expect(html).toContain(`content="default-src 'none'; style-src 'unsafe-inline'"`)
  })

  // The runtime's output lands in markup verbatim; DSH prints whatever the model
  // and its plugins wrote, so it is not ours to trust.
  test("escapes the runtime's output instead of rendering it", () => {
    const html = startupPageHtml("en", failed({ diagnosis: "", output: "<img src=x onerror=alert(1)>" }))

    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;")
    expect(html).not.toContain("<img")
  })

  // The wiring, not the wording: which cause and which locale reach the page.
  // Asserting the copy literals here would only restate startup-page-labels and
  // would break on every edit to it.
  test("renders the copy for the cause and the locale it was given", () => {
    for (const locale of ["en", "zh"] as const) {
      const copy = startupPageLabels(locale).failed
      // Splitting the two causes is only worth anything if they read
      // differently; one sentence for both would satisfy the rest of this test.
      expect(copy.startup.title).not.toBe(copy.crash.title)
      expect(startupPageHtml(locale, failed({ reason: "startup" }))).toContain(copy.startup.title)
      expect(startupPageHtml(locale, failed({ reason: "crash" }))).toContain(copy.crash.title)
    }
  })

  test("offers a retry and a way to report from every failure", () => {
    const html = startupPageHtml("en", failed())
    for (const action of ["retry", "report-issue", "show-log", "copy-details"]) {
      expect(html).toContain(`href="${STARTUP_URL}${action}"`)
    }
  })

  // Copying is the whole reason the details are markup rather than a modal, so
  // the confirmation has to survive the reload that renders it — with the block
  // it confirms still open.
  test("confirms a copy in place of offering it again", () => {
    const html = startupPageHtml("zh", failed({ copied: true }))

    // The confirmation is rendered by a reload, which collapses <details> unless
    // it is reopened — so `open` is what makes the confirmation visible at all.
    expect(html).toContain("<details open>")
    expect(html).toContain(startupPageLabels("zh").actions.copied)
    expect(html).not.toContain(`href="${STARTUP_URL}copy-details"`)
  })

  test("shows progress instead of a failure while the runtime is still starting", () => {
    const html = startupPageHtml("zh", { phase: "starting" })

    expect(html).toContain(startupPageLabels("zh").starting.title)
    expect(html).toContain('role="progressbar"')
    expect(html).not.toContain(`href="${STARTUP_URL}retry"`)
  })
})
