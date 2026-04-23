import { _electron as electron } from "@playwright/test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const scriptDir = dirname(fileURLToPath(import.meta.url))
const repo = resolve(scriptDir, "../../..")
const mainEntry = resolve(scriptDir, "../out/main/index.js")
const desktopShellMainSelector = '[data-component="desktop-shell-main"]'

const rendererError = {
  summary: "ManualSmokeError: report flow smoke check",
  details: [
    "ManualSmokeError: report flow smoke check",
    "    at real desktop smoke (/tmp/pawwork-real-report)",
    "",
    "Context",
    '{"kind":"manual-smoke","directory":"/tmp/pawwork-real-report","storage":"manual.dat","key":"manual-key"}',
  ].join("\n"),
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function buildSmokeEnv(homeDir) {
  return {
    ...process.env,
    CI: "true",
    HOME: homeDir,
    PAWWORK_CI_SMOKE: "true",
    PAWWORK_CI_SMOKE_HOME: homeDir,
    XDG_DATA_HOME: homeDir,
    XDG_CACHE_HOME: homeDir,
    XDG_CONFIG_HOME: homeDir,
    XDG_STATE_HOME: homeDir,
    OPENCODE_CHANNEL: "dev",
    PAWWORK_FEEDBACK_FORM_URL: process.env.PAWWORK_FEEDBACK_FORM_URL || "https://example.com/pawwork-feedback",
  }
}

function latestMarkdownReport(reportRoot) {
  if (!existsSync(reportRoot)) return { fileName: undefined, markdown: "" }
  const fileName = readdirSync(reportRoot)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .at(-1)
  return {
    fileName,
    markdown: fileName ? readFileSync(join(reportRoot, fileName), "utf8") : "",
  }
}

const homeDir = mkdtempSync(join(tmpdir(), "pawwork-report-smoke-"))
const app = await electron.launch({
  executablePath: require("electron/index.js"),
  args: [mainEntry],
  cwd: repo,
  env: buildSmokeEnv(homeDir),
})

try {
  const window = await app.firstWindow()
  await window.waitForLoadState("domcontentloaded")
  await window.waitForFunction(() => document.title === "PawWork", null, { timeout: 60_000 })
  await window.waitForSelector(desktopShellMainSelector, { timeout: 60_000 })

  const result = await window.evaluate(async (rendererError) => {
    const api = globalThis.api
    if (!api?.reportProblem) throw new Error("window.api.reportProblem is not available")
    return api.reportProblem({ confirm: false, rendererError })
  }, rendererError)

  const userData = await app.evaluate(({ app }) => app.getPath("userData"))
  const clipboardText = await app.evaluate(({ clipboard }) => clipboard.readText())
  const reportRoot = join(userData, "problem-reports")
  const report = latestMarkdownReport(reportRoot)

  const summary = {
    homeDir,
    userData,
    result,
    latestReport: report.fileName,
    clipboardHasSmokeSummary: clipboardText.includes(rendererError.summary),
    clipboardRedactedStorage: !clipboardText.includes("manual.dat") && !clipboardText.includes("manual-key"),
    markdownHasRendererError:
      report.markdown.includes(rendererError.summary) && report.markdown.includes('\\"kind\\":\\"manual-smoke\\"'),
    markdownHasReportPayload: report.markdown.includes("```json"),
  }

  console.log(JSON.stringify(summary, null, 2))

  assert(result?.status === "ready", `expected reportProblem to return ready; got ${JSON.stringify(result)}`)
  assert(report.fileName, "expected a saved markdown problem report")
  assert(summary.clipboardHasSmokeSummary, "expected clipboard summary to include renderer error summary")
  assert(summary.clipboardRedactedStorage, "expected clipboard summary to redact storage and key diagnostics")
  assert(summary.markdownHasRendererError, "expected full report to include renderer error details")
  assert(summary.markdownHasReportPayload, "expected full report to include the fenced JSON payload")
} finally {
  await app.close().catch(() => undefined)
  rmSync(homeDir, { force: true, recursive: true })
}
