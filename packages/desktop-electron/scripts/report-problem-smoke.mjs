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

function latestJsonReport(reportRoot) {
  if (!existsSync(reportRoot)) return { fileName: undefined, json: "", payload: undefined }
  const fileName = readdirSync(reportRoot)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .at(-1)
  const json = fileName ? readFileSync(join(reportRoot, fileName), "utf8") : ""
  const payload = json ? JSON.parse(json) : undefined
  return {
    fileName,
    json,
    payload,
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
  const report = latestJsonReport(reportRoot)
  const logTail = Array.isArray(report.payload?.logTail) ? report.payload.logTail : []

  const summary = {
    homeDir,
    userData,
    result,
    staleActions,
    latestReport: report.fileName,
    jsonHasRendererError:
      report.payload?.error?.summary === rendererError.summary &&
      report.payload?.error?.details?.includes('"kind":"manual-smoke"'),
    jsonHasAgentReadableSections:
      report.payload?.meta?.reportVersion === 1 &&
      report.payload?.environment &&
      Array.isArray(report.payload?.recentErrors) &&
      Array.isArray(report.payload?.logTail),
    jsonHasMainLog: logTail.some((line) => line.includes("== Main process log:")),
    jsonHasBackendLog: logTail.some((line) => line.includes("== Backend log:")),
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
  assert(report.fileName, "expected a saved JSON problem report")
  assert(summary.jsonHasRendererError, "expected full report to include renderer error details")
  assert(summary.jsonHasAgentReadableSections, "expected full report to include agent-readable JSON sections")
  assert(summary.jsonHasMainLog, "expected full report to include main process log tail")
  assert(summary.jsonHasBackendLog, "expected full report to include backend log tail")
} finally {
  await closeApp(app)
  rmSync(homeDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 })
}
