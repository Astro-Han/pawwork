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

function childIsRunning(child) {
  return child.exitCode === null && child.signalCode === null
}

async function withTimeout(promise, ms, timeoutValue) {
  let timeout
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(timeoutValue), ms)
      }),
    ])
  } finally {
    clearTimeout(timeout)
  }
}

async function waitForExit(child, ms) {
  if (!childIsRunning(child)) return
  await withTimeout(new Promise((resolve) => child.once("exit", resolve)), ms, undefined)
}

async function closeApp(app) {
  const child = app.process()
  const closed = await withTimeout(app.close().then(() => true).catch(() => false), 5_000, false)
  if (closed || !childIsRunning(child)) return

  child.kill("SIGKILL")
  await waitForExit(child, 5_000)
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

  // Inverted flow (#1472): prepareReport only generates + redacts + saves the package and returns review
  // metadata — no clipboard / reveal / form side effects (those are explicit follow-ups). The smoke is
  // prepare-only so it stays side-effect-free, as the old `confirm: false` path was.
  const result = await window.evaluate(async (rendererError) => {
    const api = globalThis.api
    if (!api?.prepareReport) throw new Error("window.api.prepareReport is not available")
    return api.prepareReport({ rendererError })
  }, rendererError)

  // Exercise the reveal/submit bridge end-to-end without side effects: a stale id (no pending match)
  // returns `stale` from the real main-process handlers without opening a file manager or browser.
  const staleActions = await window.evaluate(async () => {
    const api = globalThis.api
    if (!api?.revealReport || !api?.submitReport) throw new Error("reveal/submit bridge is not available")
    return {
      reveal: await api.revealReport("stale-report-id"),
      submit: await api.submitReport("stale-report-id"),
    }
  })

  const userData = await app.evaluate(({ app }) => app.getPath("userData"))
  const reportRoot = join(userData, "problem-reports")
  const report = latestMarkdownReport(reportRoot)

  const summary = {
    homeDir,
    userData,
    result,
    staleActions,
    latestReport: report.fileName,
    markdownHasRendererError:
      report.markdown.includes(rendererError.summary) && report.markdown.includes('\\"kind\\":\\"manual-smoke\\"'),
    markdownHasReportPayload: report.markdown.includes("```json"),
    markdownHasMainLog: report.markdown.includes("== Main process log:"),
    markdownHasBackendLog: report.markdown.includes("== Backend log:"),
  }

  console.log(JSON.stringify(summary, null, 2))

  assert(result?.status === "ready", `expected prepareReport to return ready; got ${JSON.stringify(result)}`)
  assert(result?.reportId, "expected prepareReport to return a reportId")
  assert(result?.fileName, "expected prepareReport to return the saved file name")
  assert(result?.contents?.rendererError === true, "expected review contents to flag the renderer error")
  assert(
    staleActions?.reveal?.status === "stale",
    `expected a stale reveal through the real bridge; got ${JSON.stringify(staleActions?.reveal)}`,
  )
  assert(
    staleActions?.submit?.status === "stale",
    `expected a stale submit through the real bridge; got ${JSON.stringify(staleActions?.submit)}`,
  )
  assert(report.fileName, "expected a saved markdown problem report")
  assert(summary.markdownHasRendererError, "expected full report to include renderer error details")
  assert(summary.markdownHasReportPayload, "expected full report to include the fenced JSON payload")
  assert(summary.markdownHasMainLog, "expected full report to include main process log tail")
  assert(summary.markdownHasBackendLog, "expected full report to include backend log tail")

  // Real entry-path walk: the blocks above call api.prepareReport directly and bypass the UI
  // wiring. Here we send the same `menu-command` the desktop Help menu emits (sendMenuCommand →
  // webContents.send("menu-command", id)) and drive the rendered review dialog through the
  // renderer's command registry + dialog provider, proving the menu → command → dialog →
  // review-panel path renders and tears down. We click Cancel (a real review-panel button →
  // onDone → dialog.close) rather than reveal/submit, whose handlers would open a real Finder /
  // browser window on the prepared package; those stay covered by the stale calls above.
  await app.evaluate(({ BrowserWindow }) => {
    const [win] = BrowserWindow.getAllWindows()
    if (!win) throw new Error("no browser window for the menu-command walk")
    win.webContents.send("menu-command", "diagnostics.prepare")
  })

  const reviewDialog = window.locator('[data-component="dialog"]')
  await reviewDialog.waitFor({ state: "visible", timeout: 30_000 })
  const reviewWalk = {
    title: (await reviewDialog.locator('[data-slot="dialog-title"]').innerText()).trim(),
    hasReveal: (await reviewDialog.getByRole("button", { name: "Show in folder" }).count()) > 0,
    hasSubmit: (await reviewDialog.getByRole("button", { name: "Continue" }).count()) > 0,
  }
  await reviewDialog.getByRole("button", { name: "Cancel", exact: true }).click()
  await reviewDialog.waitFor({ state: "hidden", timeout: 30_000 })
  const reviewDialogClosed = (await window.locator('[data-component="dialog"]').count()) === 0

  console.log(JSON.stringify({ reviewWalk, reviewDialogClosed }, null, 2))

  assert(
    reviewWalk.title === "Review before sharing",
    `expected the menu walk to open the review dialog; got ${JSON.stringify(reviewWalk)}`,
  )
  assert(
    reviewWalk.hasReveal && reviewWalk.hasSubmit,
    `expected reveal + submit actions in the review dialog; got ${JSON.stringify(reviewWalk)}`,
  )
  assert(reviewDialogClosed, "expected the review dialog to close after Cancel")
} finally {
  await closeApp(app)
  rmSync(homeDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 })
}
