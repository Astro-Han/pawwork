import fs from "node:fs/promises"
import path from "node:path"
import { raw } from "../../../opencode/test/lib/llm-server"
import { test, expect } from "../fixtures"
import { cleanupSession, waitSessionIdle, waitSessionSaved, waitTerminalFocusIdle, withSession } from "../actions"
import {
  promptSelector,
  sessionMessageItemSelector,
  sessionTurnListSelector,
  scrollViewportSelector,
  terminalSelector,
} from "../selectors"
import { sessionPath, terminalToggleKey } from "../utils"
import type { createSdk } from "../utils"
import { composerEvent, type ComposerDriverState, type ComposerWindow } from "../../src/testing/session-composer"
import { installPerfProbe, resetPerfProbe, snapshotPerfProbe, summarizeScenarioRuns } from "./probe"
import { applyPerfProfile, readPerfProfile, shouldRunScenario, type PerfScenarioName } from "./profiles"
import {
  TIMELINE_RECOMPUTE_SEED_TURN_COUNT,
  buildHeterogeneousScrollSeedText,
  seedTimelineRecomputeSession,
} from "./timeline-fixture"
import { CONCURRENT_SHIMMER_COUNT, buildConcurrentShimmerReply } from "./concurrent-shimmer-fixture"

const outputPath =
  process.env.PAWWORK_PERF_OUTPUT ?? path.join(process.cwd(), "e2e", "perf-results", "pr0.1-baseline.json")
const perfBranch = process.env.PAWWORK_PERF_BRANCH ?? "dev"
const PERF_PROFILE = readPerfProfile()

const longMarkdown = [
  "# Baseline stream",
  "",
  "This stream exists to stress markdown rendering while the session remains interactive.",
  "",
  "- list item one",
  "- list item two with a [link](https://example.com)",
  "- 中英混排 content for layout and glyph coverage",
  "",
  "```ts",
  "export function sample(input: number) {",
  "  return input * 2",
  "}",
  "```",
  "",
  ...Array.from({ length: 80 }, (_, index) => `Paragraph ${index + 1}: ${"streaming markdown content ".repeat(8)}`),
].join("\n")

const heavyBashCommand =
  'node -e \'for (let i = 0; i < 900; i++) console.log(String(i).padStart(4, "0") + " " + "heavy bash output ".repeat(8))\''

const inputLagText = [
  "Long session input lag probe.",
  "Typing remains responsive while a realistic message history is mounted.",
  "This fixed draft protects the composer path from timeline render regressions.",
].join(" ")

const longScrollSeedTurns = 104
const sessionVirtualizerSelector = '[data-component="session-timeline-virtualizer"]'
const sessionVirtualRowSelector = '[data-component="session-virtual-row"]'
const longScrollMinimumAvailableRows = 80
const longScrollMaximumMountedMessages = 48
const longScrollCoverageRatio = 0.95
const longScrollMinimumProbeWindowMs = 15_000
const longScrollMaxRouteDurationMs = 30_000
const longScrollTargetMovingSamples = 32
const longScrollMinimumMovingSamples = 16
const longScrollMinimumDistinctScrollTops = 12

const scenarioResults: ReturnType<typeof summarizeScenarioRuns>[] = []

type PerfSdk = ReturnType<typeof createSdk>
type PerfProject = {
  directory: string
  url: string
  sdk: PerfSdk
  trackSession: (sessionID: string) => void
}
type PerfLlm = {
  tool: (name: string, input: unknown) => Promise<void>
}

type TimelineMetrics = {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  maxScrollTop: number
}

type WheelRouteResult = {
  events: number
  movingSamples: number
  distinctScrollTopSamples: number
  distancePx: number
  durationMs: number
  final: TimelineMetrics
}

const chatChunk = (
  delta: Record<string, unknown>,
  input?: { finish?: string; usage?: { input: number; output: number } },
) => ({
  id: "chatcmpl-test",
  object: "chat.completion.chunk",
  choices: [
    {
      delta,
      ...(input?.finish ? { finish_reason: input.finish } : {}),
    },
  ],
  ...(input?.usage
    ? {
        usage: {
          prompt_tokens: input.usage.input,
          completion_tokens: input.usage.output,
          total_tokens: input.usage.input + input.usage.output,
        },
      }
    : {}),
})

function splitText(value: string, size: number) {
  const out: string[] = []
  for (let index = 0; index < value.length; index += size) {
    out.push(value.slice(index, index + size))
  }
  return out
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function settleFrames(page: Parameters<typeof snapshotPerfProbe>[0], count = 2) {
  await page.evaluate(async (frames) => {
    for (let index = 0; index < frames; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
  }, count)
}

async function cooldownAfterRun(page: Parameters<typeof snapshotPerfProbe>[0]) {
  await settleFrames(page, 6)
  await page.waitForTimeout(250)
}

async function ensureTerminalClosed(page: Parameters<typeof snapshotPerfProbe>[0]) {
  const terminal = page.locator(terminalSelector)
  const visible = await terminal.isVisible().catch(() => false)
  if (!visible) return
  await page.keyboard.press(terminalToggleKey)
  await expect(terminal).toHaveCount(0)
}

async function navigateProjectHome(page: Parameters<typeof snapshotPerfProbe>[0], directory: string) {
  await page.goto(sessionPath(directory))
  await expect(page.locator('[data-component="session-new-home"]')).toBeVisible()
}

async function readPromptSend(page: Parameters<typeof snapshotPerfProbe>[0]) {
  return page.evaluate(() => {
    const win = window as Window & {
      __opencode_e2e?: {
        prompt?: {
          sent?: {
            started?: number
            count?: number
            sessionID?: string
          }
        }
      }
    }
    const sent = win.__opencode_e2e?.prompt?.sent
    return {
      started: sent?.started ?? 0,
      count: sent?.count ?? 0,
      sessionID: sent?.sessionID,
    }
  })
}

async function submitVisiblePrompt(page: Parameters<typeof snapshotPerfProbe>[0], text: string) {
  const prompt = page.locator(promptSelector).first()
  const previous = await readPromptSend(page)
  await expect(prompt).toBeVisible()
  await prompt.click()
  await prompt.fill("")
  await page.keyboard.type(text)
  await page.keyboard.press("Enter")
  await expect
    .poll(async () => (await readPromptSend(page)).started, { timeout: 10_000 })
    .toBeGreaterThan(previous.started)
}

async function readPromptText(page: Parameters<typeof snapshotPerfProbe>[0]) {
  return page
    .locator(promptSelector)
    .first()
    .evaluate((el) => (el.textContent ?? "").replace(/\u200B/g, "").trim())
}

async function revealCachedSessionMessages(page: Parameters<typeof snapshotPerfProbe>[0], expectedCount: number) {
  const messages = page.locator(sessionMessageItemSelector)
  if ((await messages.count()) < expectedCount) {
    await page.locator(scrollViewportSelector).first().hover()
    await page.mouse.wheel(0, -2400)
    await settleFrames(page, 2)
    await scrollTimelineTo(page, 0)
    await settleFrames(page, 2)
    const loadEarlier = page.getByRole("button", { name: /Load earlier messages|加载更早的消息/i }).first()
    await expect(loadEarlier).toBeVisible({ timeout: 30_000 })
    await loadEarlier.click()
  }
  await expect
    .poll(async () => (await readTimelineDomBudget(page)).totalRows, { timeout: 30_000 })
    .toBeGreaterThanOrEqual(expectedCount)
}

async function readTimelineDomBudget(page: Parameters<typeof snapshotPerfProbe>[0]) {
  return page.evaluate(
    ({ messageSelector, rowSelector, virtualizerSelector }) => {
      const virtualizer = document.querySelector(virtualizerSelector)
      const rows = Array.from(document.querySelectorAll(rowSelector))
      const messages = Array.from(document.querySelectorAll(messageSelector))
      const virtualizedTotalRows = Number((virtualizer as HTMLElement | null)?.dataset.totalRows ?? 0)
      return {
        hasVirtualizer: virtualizer instanceof HTMLElement,
        totalRows: virtualizedTotalRows > 0 ? virtualizedTotalRows : messages.length,
        mountedRows: rows.length,
        mountedMessages: messages.length,
        visibleRows: rows.filter((row) => {
          if (!(row instanceof HTMLElement)) return false
          const rect = row.getBoundingClientRect()
          return rect.bottom > 0 && rect.top < window.innerHeight
        }).length,
      }
    },
    {
      messageSelector: sessionMessageItemSelector,
      rowSelector: sessionVirtualRowSelector,
      virtualizerSelector: sessionVirtualizerSelector,
    },
  )
}

async function scrollTimelineTo(page: Parameters<typeof snapshotPerfProbe>[0], top: number) {
  const found = await page.evaluate(
    ({ top, scrollViewportSelector, turnListSelector }) => {
      const list = document.querySelector(turnListSelector)
      const viewport = list?.closest(scrollViewportSelector)
      if (!(viewport instanceof HTMLElement)) return false
      viewport.scrollTop = top
      viewport.dispatchEvent(new Event("scroll", { bubbles: true }))
      return true
    },
    { top, scrollViewportSelector, turnListSelector: sessionTurnListSelector },
  )
  expect(found).toBe(true)
}

async function hoverTimelineScrollLane(page: Parameters<typeof snapshotPerfProbe>[0]) {
  const box = await page.locator(scrollViewportSelector).first().boundingBox()
  expect(box).toBeTruthy()
  if (!box) return
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(120, box.height * 0.25))
}

async function readTimelineMetrics(page: Parameters<typeof snapshotPerfProbe>[0]) {
  const metrics = await page.evaluate(
    ({ scrollViewportSelector, turnListSelector }) => {
      const list = document.querySelector(turnListSelector)
      const viewport = list?.closest(scrollViewportSelector)
      if (!(viewport instanceof HTMLElement)) return undefined
      const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
      return {
        scrollTop: viewport.scrollTop,
        scrollHeight: viewport.scrollHeight,
        clientHeight: viewport.clientHeight,
        maxScrollTop,
      }
    },
    { scrollViewportSelector, turnListSelector: sessionTurnListSelector },
  )
  expect(metrics).toBeTruthy()
  return metrics as TimelineMetrics
}

function longScrollSeedText(run: number, index: number) {
  return buildHeterogeneousScrollSeedText({ run, turn: index })
}

async function seedLongScrollSession(project: PerfProject, sessionID: string, run: number) {
  for (let index = 0; index < longScrollSeedTurns; index += 1) {
    await project.sdk.session.promptAsync({
      sessionID,
      noReply: true,
      parts: [{ type: "text", text: longScrollSeedText(run, index) }],
    })
  }
}

async function revealLongScrollWindow(page: Parameters<typeof snapshotPerfProbe>[0]) {
  const messages = page.locator(sessionMessageItemSelector)
  await expect(messages.first()).toBeVisible({ timeout: 30_000 })
  await hoverTimelineScrollLane(page)
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const budget = await readTimelineDomBudget(page)
    if (budget.totalRows >= longScrollMinimumAvailableRows) return
    await page.mouse.wheel(0, -2400)
    await settleFrames(page, 2)
    await scrollTimelineTo(page, 0)
    await settleFrames(page, 2)
  }
  await expect
    .poll(async () => (await readTimelineDomBudget(page)).totalRows, { timeout: 1_000 })
    .toBeGreaterThanOrEqual(longScrollMinimumAvailableRows)
}

async function installComposerPerfDriver(page: Parameters<typeof snapshotPerfProbe>[0]) {
  await page.addInitScript(() => {
    const win = window as ComposerWindow
    const saved = window.sessionStorage.getItem("__opencode_e2e_composer_sessions")
    const sessions = saved ? JSON.parse(saved) : {}
    win.__opencode_e2e = { ...win.__opencode_e2e, composer: { enabled: true, sessions } }
  })
}

async function writeComposerDriver(
  page: Parameters<typeof snapshotPerfProbe>[0],
  sessionID: string,
  driver: ComposerDriverState | undefined,
) {
  await page.evaluate(
    (input: { event: string; sessionID: string; driver: ComposerDriverState | undefined }) => {
      const win = window as ComposerWindow
      const composer = win.__opencode_e2e?.composer
      if (!composer?.enabled) throw new Error("Composer e2e driver is not enabled")
      composer.sessions ??= {}
      const prev = composer.sessions[input.sessionID] ?? {}
      if (!input.driver) {
        delete composer.sessions[input.sessionID]
      } else {
        composer.sessions[input.sessionID] = { ...prev, driver: input.driver }
      }
      window.sessionStorage.setItem("__opencode_e2e_composer_sessions", JSON.stringify(composer.sessions))
      window.dispatchEvent(new CustomEvent(input.event, { detail: { sessionID: input.sessionID } }))
    },
    { event: composerEvent, sessionID, driver },
  )
}

function longScrollTodoDriver(run: number, phase: number): ComposerDriverState {
  const count = 4 + phase
  return {
    todos: Array.from({ length: count }, (_, index) => ({
      content: `scroll perf active task ${run}-${phase}-${index}`,
      priority: index === 0 ? "high" : index % 3 === 0 ? "low" : "medium",
      status: index < phase ? "completed" : index === phase ? "in_progress" : "pending",
    })),
  }
}

function longScrollTodoPulse(page: Parameters<typeof snapshotPerfProbe>[0], sessionID: string, run: number) {
  const checkpoints = [700, 1_600, 2_800, 4_200]
  let next = 0
  return async (elapsedMs: number) => {
    while (next < checkpoints.length && elapsedMs >= checkpoints[next]) {
      next += 1
      await writeComposerDriver(page, sessionID, longScrollTodoDriver(run, next))
    }
  }
}

function calculateLongScrollStepPx(maxScrollTop: number) {
  const target = Math.ceil((maxScrollTop * longScrollCoverageRatio) / longScrollTargetMovingSamples)
  return Math.max(160, Math.min(900, target))
}

async function trackWheelMovement(
  page: Parameters<typeof snapshotPerfProbe>[0],
  input: {
    direction: 1 | -1
    stepPx: number
    previous: TimelineMetrics
    startedAt: number
    onPulse?: (elapsedMs: number) => Promise<void>
  },
) {
  await page.mouse.wheel(0, input.direction * input.stepPx)
  await input.onPulse?.(Date.now() - input.startedAt)
  await page.waitForTimeout(16)

  const next = await readTimelineMetrics(page)
  const delta = Math.abs(next.scrollTop - input.previous.scrollTop)
  return { next, delta }
}

async function driveWheelToRatio(
  page: Parameters<typeof snapshotPerfProbe>[0],
  input: {
    direction: 1 | -1
    targetRatio: number
    stepPx: number
    startedAt: number
    onPulse?: (elapsedMs: number) => Promise<void>
  },
) {
  const started = Date.now()
  let events = 0
  let movingSamples = 0
  let distancePx = 0
  let previous = await readTimelineMetrics(page)
  const distinct = new Set([Math.round(previous.scrollTop)])
  await hoverTimelineScrollLane(page)

  while (Date.now() - started < longScrollMaxRouteDurationMs) {
    const { next, delta } = await trackWheelMovement(page, {
      direction: input.direction,
      stepPx: input.stepPx,
      previous,
      startedAt: input.startedAt,
      onPulse: input.onPulse,
    })
    events += 1
    if (delta > 0.5) {
      movingSamples += 1
      distancePx += delta
      distinct.add(Math.round(next.scrollTop))
    }
    previous = next

    const ratio = next.maxScrollTop > 0 ? next.scrollTop / next.maxScrollTop : 0
    const reached = input.direction === 1 ? ratio >= input.targetRatio : ratio <= input.targetRatio
    if (reached && movingSamples >= longScrollMinimumMovingSamples) break
  }

  return {
    events,
    movingSamples,
    distinctScrollTopSamples: distinct.size,
    distancePx,
    durationMs: Date.now() - started,
    final: previous,
  }
}

async function sustainMovingScrollWindow(
  page: Parameters<typeof snapshotPerfProbe>[0],
  input: {
    startedAt: number
    stepPx: number
    onPulse?: (elapsedMs: number) => Promise<void>
  },
): Promise<WheelRouteResult> {
  const started = Date.now()
  let events = 0
  let movingSamples = 0
  let distancePx = 0
  let direction: 1 | -1 = 1
  let previous = await readTimelineMetrics(page)
  const distinct = new Set([Math.round(previous.scrollTop)])
  await hoverTimelineScrollLane(page)

  while (Date.now() - input.startedAt < longScrollMinimumProbeWindowMs) {
    const ratio = previous.maxScrollTop > 0 ? previous.scrollTop / previous.maxScrollTop : 0
    if (ratio >= 0.85) direction = -1
    if (ratio <= 0.15) direction = 1

    const { next, delta } = await trackWheelMovement(page, {
      direction,
      stepPx: input.stepPx,
      previous,
      startedAt: input.startedAt,
      onPulse: input.onPulse,
    })
    events += 1
    if (delta > 0.5) {
      movingSamples += 1
      distancePx += delta
      distinct.add(Math.round(next.scrollTop))
    }
    previous = next
  }

  return {
    events,
    movingSamples,
    distinctScrollTopSamples: distinct.size,
    distancePx,
    durationMs: Date.now() - started,
    final: previous,
  }
}

async function expandLongScrollTodoDock(page: Parameters<typeof snapshotPerfProbe>[0]) {
  const dock = page.locator('[data-component="session-todo-dock"]').first()
  await expect(dock).toBeVisible({ timeout: 10_000 })
  await dock.locator('[data-action="session-todo-toggle-button"]').click()
  const list = dock.locator('[data-slot="session-todo-list"]')
  await expect(list).toHaveAttribute("aria-hidden", "false", { timeout: 5_000 })
  await expect.poll(async () => (await dock.boundingBox())?.height ?? -1).toBeGreaterThan(60)
}

async function enableShellToolPartsExpanded(page: Parameters<typeof snapshotPerfProbe>[0]) {
  const apply = () => {
    const raw = localStorage.getItem("settings.v3")
    const current = (() => {
      if (!raw) return {}
      try {
        return JSON.parse(raw) as Record<string, unknown>
      } catch {
        return {}
      }
    })()
    const general = current.general && typeof current.general === "object" ? current.general : {}
    localStorage.setItem(
      "settings.v3",
      JSON.stringify({
        ...current,
        general: {
          ...general,
          shellToolPartsExpanded: true,
        },
      }),
    )
  }

  await page.addInitScript(apply)
  await page.evaluate(apply)
}

async function seedHeavyBashSession(input: { project: PerfProject; llm: PerfLlm; run: number }) {
  const session = await input.project.sdk.session
    .create({
      title: `perf heavy bash ${Date.now()}-${input.run}`,
      permission: [{ permission: "bash", pattern: "*", action: "allow" }],
    })
    .then((result) => result.data)
  if (!session?.id) throw new Error("Session create did not return an id")
  input.project.trackSession(session.id)

  await input.llm.tool("bash", {
    command: heavyBashCommand,
    description: "Prints heavy deterministic output",
  })
  await input.project.sdk.session.promptAsync({
    sessionID: session.id,
    agent: "build",
    parts: [{ type: "text", text: "Run the heavy bash perf fixture." }],
  })
  await waitSessionIdle(input.project.sdk, session.id, 90_000)
  await waitSessionSaved(input.project.directory, session.id, 90_000, input.project.url)

  await expect
    .poll(
      async () => {
        const messages = await input.project.sdk.session.messages({ sessionID: session.id, limit: 20 })
        return (messages.data ?? []).some((message) =>
          message.parts.some(
            (part) =>
              part.type === "tool" &&
              part.tool === "bash" &&
              part.state.status === "completed" &&
              typeof part.state.output === "string" &&
              part.state.output.includes("heavy bash output"),
          ),
        )
      },
      { timeout: 30_000 },
    )
    .toBe(true)

  return session
}

function skipUnlessScenario(name: PerfScenarioName) {
  test.skip(!shouldRunScenario(PERF_PROFILE, name), `${PERF_PROFILE} profile does not run ${name}`)
}

test.describe("PR0.1 perf probe baseline", () => {
  test.describe.configure({ mode: "serial" })

  test.afterAll(async () => {
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, `${JSON.stringify(scenarioResults, null, 2)}\n`)
  })

  test("homepage-cold emits a 3-run JSON baseline", async ({ page, project }) => {
    skipUnlessScenario("homepage-cold")
    await installPerfProbe(page)
    await applyPerfProfile(page, PERF_PROFILE)
    await project.open()

    const runs = []
    for (let run = 0; run < 3; run += 1) {
      if (run > 0) await navigateProjectHome(page, project.directory)
      const prompt = page.locator(promptSelector).first()
      await expect(prompt).toBeVisible()
      await prompt.click()
      await page.getByRole("button", { name: /Switch workspace|切换工作目录/i }).click()
      await settleFrames(page, 3)
      await page.keyboard.press("Escape")
      runs.push(await snapshotPerfProbe(page))
      if (run < 2) await cooldownAfterRun(page)
    }

    scenarioResults.push(
      summarizeScenarioRuns({ branch: perfBranch, profile: PERF_PROFILE, scenario: "homepage-cold", runs }),
    )
  })

  test("long-session-input-lag emits a 3-run JSON baseline", async ({ page, project }) => {
    skipUnlessScenario("long-session-input-lag")
    await installPerfProbe(page)
    await applyPerfProfile(page, PERF_PROFILE)
    await project.open()

    const runs = []
    for (let run = 0; run < 3; run += 1) {
      await withSession(project.sdk, `perf input lag ${Date.now()}-${run}`, async (session) => {
        await seedTimelineRecomputeSession(project, session.id)
        await page.goto(sessionPath(project.directory, session.id))
        await expect(page.locator(sessionMessageItemSelector).first()).toBeVisible({ timeout: 30_000 })
        await expect(page.locator(promptSelector).first()).toBeVisible({ timeout: 30_000 })
        await revealCachedSessionMessages(page, TIMELINE_RECOMPUTE_SEED_TURN_COUNT)

        const prompt = page.locator(promptSelector).first()
        await prompt.click()
        await prompt.fill("")
        await expect
          .poll(async () => (await readTimelineDomBudget(page)).totalRows)
          .toBeGreaterThanOrEqual(TIMELINE_RECOMPUTE_SEED_TURN_COUNT)
        await resetPerfProbe(page)
        await page.keyboard.type(`${inputLagText} run ${run + 1}.`)
        await expect.poll(() => readPromptText(page)).toBe(`${inputLagText} run ${run + 1}.`)
        await settleFrames(page, 4)
        runs.push(await snapshotPerfProbe(page))
        if (run < 2) await cooldownAfterRun(page)
      })
    }

    scenarioResults.push(
      summarizeScenarioRuns({ branch: perfBranch, profile: PERF_PROFILE, scenario: "long-session-input-lag", runs }),
    )
  })

  test("session-streaming-long emits a 3-run JSON baseline", async ({ page, project, llm }) => {
    skipUnlessScenario("session-streaming-long")
    await installPerfProbe(page)
    await applyPerfProfile(page, PERF_PROFILE)
    await project.open()

    const runs = []
    for (let run = 0; run < 3; run += 1) {
      const firstWave = deferred()
      const secondWave = deferred()
      const chunks = splitText(longMarkdown, 320)
      const headChunks = [
        chatChunk({ role: "assistant" }),
        ...chunks.slice(0, 3).map((chunk) => chatChunk({ content: chunk })),
      ]
      const stageOneChunks = chunks.slice(3, 9).map((chunk) => chatChunk({ content: chunk }))
      const stageTwoChunks = chunks.slice(9).map((chunk) => chatChunk({ content: chunk }))

      await navigateProjectHome(page, project.directory)
      await llm.push(
        raw({
          head: headChunks,
          stages: [
            { wait: firstWave.promise, chunks: stageOneChunks },
            { wait: secondWave.promise, chunks: stageTwoChunks },
          ],
          tail: [chatChunk({}, { finish: "stop", usage: { input: 120, output: 480 } })],
        }),
      )

      const send = project.prompt(`Stream probe ${run + 1}`)
      await expect.poll(() => page.url(), { timeout: 30_000 }).toContain("/session/")
      await expect(
        page.getByText("This stream exists to stress markdown rendering while the session remains interactive."),
      ).toBeVisible({
        timeout: 30_000,
      })

      await resetPerfProbe(page)
      const click = page.getByRole("button", { name: "Right utility panel" }).click()
      firstWave.resolve()
      await click
      await settleFrames(page, 6)
      secondWave.resolve()
      await send
      runs.push(await snapshotPerfProbe(page))
      if (run < 2) await cooldownAfterRun(page)
    }

    scenarioResults.push(
      summarizeScenarioRuns({ branch: perfBranch, profile: PERF_PROFILE, scenario: "session-streaming-long", runs }),
    )
  })

  test("tool-call-expand emits a 3-run JSON baseline", async ({ page, project, llm }) => {
    skipUnlessScenario("tool-call-expand")
    await installPerfProbe(page)
    await applyPerfProfile(page, PERF_PROFILE)
    await project.open()

    const runs = []
    for (let run = 0; run < 3; run += 1) {
      await navigateProjectHome(page, project.directory)
      const created = await project.sdk.worktree.create({ directory: project.directory }).then((result) => result.data)
      if (!created?.directory) throw new Error("Failed to create worktree for perf probe")
      project.trackDirectory(created.directory)
      await llm.tool("enter-worktree", { path: created.directory })
      await llm.text(`tool call baseline ${run + 1}`)
      await project.prompt(`Create todos for perf probe run ${run + 1}.`)
      const trigger = page
        .locator('[data-slot="collapsible-trigger"]')
        .filter({ has: page.locator('[data-component="tool-trigger"]') })
        .first()
      await expect(trigger).toBeVisible({ timeout: 30_000 })
      await resetPerfProbe(page)
      await trigger.click()
      await expect(trigger).toHaveAttribute("aria-expanded", "true")
      await trigger.click()
      await expect(trigger).toHaveAttribute("aria-expanded", "false")
      await trigger.click()
      await expect(trigger).toHaveAttribute("aria-expanded", "true")
      await settleFrames(page, 4)
      runs.push(await snapshotPerfProbe(page))
      if (run < 2) await cooldownAfterRun(page)
    }

    scenarioResults.push(
      summarizeScenarioRuns({ branch: perfBranch, profile: PERF_PROFILE, scenario: "tool-call-expand", runs }),
    )
  })

  test("tool-default-open-heavy-bash emits a 3-run JSON baseline", async ({ page, project, llm }) => {
    skipUnlessScenario("tool-default-open-heavy-bash")
    await installPerfProbe(page)
    await applyPerfProfile(page, PERF_PROFILE)
    await project.open()
    await enableShellToolPartsExpanded(page)

    const runs = []
    for (let run = 0; run < 3; run += 1) {
      const session = await seedHeavyBashSession({ project, llm, run })
      try {
        await page.goto(sessionPath(project.directory, session.id))
        const trigger = page
          .locator('[data-slot="collapsible-trigger"]')
          .filter({ has: page.locator('[data-component="tool-trigger"]') })
          .first()
        await expect(trigger).toBeVisible({ timeout: 30_000 })
        await expect(trigger).toHaveAttribute("aria-expanded", "true")
        await settleFrames(page, 2)
        runs.push(await snapshotPerfProbe(page))
      } finally {
        await cleanupSession({ sdk: project.sdk, sessionID: session.id }).catch(() => undefined)
      }
      if (run < 2) await cooldownAfterRun(page)
    }

    scenarioResults.push(
      summarizeScenarioRuns({
        branch: perfBranch,
        profile: PERF_PROFILE,
        scenario: "tool-default-open-heavy-bash",
        runs,
      }),
    )
  })

  test("terminal-side-panel-open emits a 3-run JSON baseline", async ({ page, project }) => {
    skipUnlessScenario("terminal-side-panel-open")
    await installPerfProbe(page)
    await applyPerfProfile(page, PERF_PROFILE)
    await project.open()

    const runs = []
    for (let run = 0; run < 3; run += 1) {
      await withSession(project.sdk, `perf terminal ${Date.now()}-${run}`, async (session) => {
        await page.goto(sessionPath(project.directory, session.id))
        await expect(page.locator(promptSelector).first()).toBeVisible({ timeout: 30_000 })

        const terminal = page.locator(terminalSelector)

        await ensureTerminalClosed(page)
        await resetPerfProbe(page)
        await page.keyboard.press(terminalToggleKey)
        await waitTerminalFocusIdle(page, { term: terminal.first() })
        await settleFrames(page, 4)
        runs.push(await snapshotPerfProbe(page))
        await page.keyboard.press(terminalToggleKey)
        await expect(terminal).toHaveCount(0)
        if (run < 2) await cooldownAfterRun(page)
      })
    }

    scenarioResults.push(
      summarizeScenarioRuns({ branch: perfBranch, profile: PERF_PROFILE, scenario: "terminal-side-panel-open", runs }),
    )
  })

  test("session-scroll-reading emits a 3-run JSON baseline", async ({ page, project }) => {
    skipUnlessScenario("session-scroll-reading")
    await installPerfProbe(page)
    await applyPerfProfile(page, PERF_PROFILE)
    await project.open()

    const runs = []
    for (let run = 0; run < 3; run += 1) {
      await withSession(project.sdk, `perf scroll ${Date.now()}-${run}`, async (session) => {
        for (let index = 0; index < 18; index += 1) {
          await project.sdk.session.promptAsync({
            sessionID: session.id,
            noReply: true,
            parts: [
              {
                type: "text",
                text: `scroll seed ${run}-${index}\n${Array.from({ length: 18 }, (_, line) => `line ${line} ${"content ".repeat(8)}`).join("\n")}`,
              },
            ],
          })
        }

        await page.goto(sessionPath(project.directory, session.id))
        await expect(page.locator(sessionMessageItemSelector).first()).toBeVisible({ timeout: 30_000 })
        await expect.poll(async () => page.locator(sessionMessageItemSelector).count()).toBeGreaterThanOrEqual(8)
        await resetPerfProbe(page)
        await hoverTimelineScrollLane(page)
        await page.mouse.wheel(0, -3600)
        await settleFrames(page, 2)
        await scrollTimelineTo(page, 0)
        await settleFrames(page, 2)
        await page.mouse.wheel(0, 3600)
        await settleFrames(page, 4)
        runs.push(await snapshotPerfProbe(page))
        if (run < 2) await cooldownAfterRun(page)
      })
    }

    scenarioResults.push(
      summarizeScenarioRuns({ branch: perfBranch, profile: PERF_PROFILE, scenario: "session-scroll-reading", runs }),
    )
  })

  test("session-scroll-reading-long emits a low-end full-coverage JSON baseline", async ({ page, project }) => {
    skipUnlessScenario("session-scroll-reading-long")
    test.setTimeout(180_000)
    await installComposerPerfDriver(page)
    await installPerfProbe(page)
    await applyPerfProfile(page, PERF_PROFILE)
    await project.open()

    const runs = []
    for (let run = 0; run < 3; run += 1) {
      await withSession(project.sdk, `perf scroll long ${Date.now()}-${run}`, async (session) => {
        await seedLongScrollSession(project, session.id, run)
        await page.goto(sessionPath(project.directory, session.id))
        await revealLongScrollWindow(page)
        const budget = await readTimelineDomBudget(page)
        expect(budget.totalRows).toBeGreaterThanOrEqual(longScrollMinimumAvailableRows)
        if (perfBranch !== "base") {
          expect(budget.hasVirtualizer).toBe(true)
          expect(budget.mountedMessages).toBeLessThanOrEqual(longScrollMaximumMountedMessages)
          expect(budget.mountedMessages).toBeLessThan(budget.totalRows)
        }
        await writeComposerDriver(page, session.id, longScrollTodoDriver(run, 0))
        await expandLongScrollTodoDock(page)

        await hoverTimelineScrollLane(page)
        await scrollTimelineTo(page, 0)
        await settleFrames(page, 4)
        const atTop = await readTimelineMetrics(page)
        expect(atTop.maxScrollTop).toBeGreaterThan(4_000)
        const stepPx = calculateLongScrollStepPx(atTop.maxScrollTop)

        await resetPerfProbe(page)
        const startedAt = Date.now()
        const pulse = longScrollTodoPulse(page, session.id, run)
        const down = await driveWheelToRatio(page, {
          direction: 1,
          targetRatio: longScrollCoverageRatio,
          stepPx,
          startedAt,
          onPulse: pulse,
        })
        await settleFrames(page, 2)
        const atBottom = down.final
        const downCoverage = atBottom.maxScrollTop > 0 ? atBottom.scrollTop / atBottom.maxScrollTop : 0
        expect(down.movingSamples).toBeGreaterThanOrEqual(longScrollMinimumMovingSamples)
        expect(down.distinctScrollTopSamples).toBeGreaterThanOrEqual(longScrollMinimumDistinctScrollTops)
        expect(downCoverage).toBeGreaterThanOrEqual(longScrollCoverageRatio)

        const up = await driveWheelToRatio(page, {
          direction: -1,
          targetRatio: 1 - longScrollCoverageRatio,
          stepPx,
          startedAt,
        })
        await settleFrames(page, 4)
        const backAtTop = up.final
        const remainingTopRatio = backAtTop.maxScrollTop > 0 ? backAtTop.scrollTop / backAtTop.maxScrollTop : 0
        expect(up.movingSamples).toBeGreaterThanOrEqual(longScrollMinimumMovingSamples)
        expect(up.distinctScrollTopSamples).toBeGreaterThanOrEqual(longScrollMinimumDistinctScrollTops)
        expect(remainingTopRatio).toBeLessThanOrEqual(1 - longScrollCoverageRatio)

        const sustain = await sustainMovingScrollWindow(page, { startedAt, stepPx, onPulse: pulse })
        const totalMovingSamples = down.movingSamples + up.movingSamples + sustain.movingSamples
        const totalDistinctScrollTops =
          down.distinctScrollTopSamples + up.distinctScrollTopSamples + sustain.distinctScrollTopSamples
        expect(totalMovingSamples).toBeGreaterThanOrEqual(longScrollMinimumMovingSamples * 3)
        expect(totalDistinctScrollTops).toBeGreaterThanOrEqual(longScrollMinimumDistinctScrollTops * 3)

        const sample = await snapshotPerfProbe(page)
        expect(sample.window_ms).toBeGreaterThanOrEqual(15_000)
        runs.push(sample)
        await writeComposerDriver(page, session.id, undefined)
        if (run < 2) await cooldownAfterRun(page)
      })
    }

    scenarioResults.push(
      summarizeScenarioRuns({
        branch: perfBranch,
        profile: PERF_PROFILE,
        scenario: "session-scroll-reading-long",
        runs,
      }),
    )
  })

  test("session-timeline-recompute emits a 3-run low-end JSON baseline", async ({ page, project }) => {
    skipUnlessScenario("session-timeline-recompute")
    await installPerfProbe(page)
    await applyPerfProfile(page, PERF_PROFILE)
    await project.open()

    const runs = []
    for (let run = 0; run < 3; run += 1) {
      await withSession(project.sdk, `perf timeline recompute ${Date.now()}-${run}`, async (session) => {
        await seedTimelineRecomputeSession(project, session.id)
        await page.goto(sessionPath(project.directory, session.id))
        await expect(page.locator(sessionMessageItemSelector).first()).toBeVisible({ timeout: 30_000 })
        await expect.poll(async () => page.locator(sessionMessageItemSelector).count()).toBeGreaterThanOrEqual(8)
        await resetPerfProbe(page)
        await page.locator(scrollViewportSelector).first().hover()
        for (let index = 0; index < 4; index += 1) {
          await page.mouse.wheel(0, index % 2 === 0 ? 2400 : -2400)
          await settleFrames(page, 2)
          await scrollTimelineTo(page, index % 2 === 0 ? 0 : 1200)
          await settleFrames(page, 2)
        }
        runs.push(await snapshotPerfProbe(page))
        if (run < 2) await cooldownAfterRun(page)
      })
    }

    scenarioResults.push(
      summarizeScenarioRuns({
        branch: perfBranch,
        profile: PERF_PROFILE,
        scenario: "session-timeline-recompute",
        runs,
      }),
    )
  })

  test("concurrent-shimmer-extreme emits a low-end JSON baseline", async ({ page, project, llm }) => {
    skipUnlessScenario("concurrent-shimmer-extreme")
    // 4× CPU throttle + 40 concurrent tool dispatches eats the default 60s budget.
    test.setTimeout(180_000)
    await installPerfProbe(page)
    await applyPerfProfile(page, PERF_PROFILE)
    await project.open()

    // Single run: the hanging-LLM pattern leaves an SSE stream open for the
    // whole sample window, so resetting between runs is fragile. The comparator
    // medians over runs anyway, so a one-run sample still produces a clean
    // base-vs-head delta for regression detection.
    await navigateProjectHome(page, project.directory)
    await llm.push(buildConcurrentShimmerReply(CONCURRENT_SHIMMER_COUNT))
    await project.prompt("Concurrent shimmer probe.")

    // Virtualization may keep some bottom rows unmounted; ≥ 8 active shimmer
    // rows is enough to stress the renderer and keep base/head comparable.
    const activeShimmerRows = page.locator('[data-component="tool-trigger"]').filter({
      has: page.locator('[data-slot="text-shimmer-char-shimmer"][data-run="true"]'),
    })
    await expect.poll(() => activeShimmerRows.count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(8)

    // Guard against CI runners with reduced-motion forced on — text-shimmer.css
    // disables the animation entirely in that mode, which would silently mask
    // any regression.
    const reducedMotion = await page.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches)
    expect(reducedMotion).toBe(false)

    // Sample idle-shimmer cost across at least 2 full 1800ms cycles so the
    // probe captures sustained animation pressure, not a single-frame settle.
    await resetPerfProbe(page)
    await page.waitForTimeout(3_600)
    await settleFrames(page, 4)
    const runs = [await snapshotPerfProbe(page)]

    scenarioResults.push(
      summarizeScenarioRuns({
        branch: perfBranch,
        profile: PERF_PROFILE,
        scenario: "concurrent-shimmer-extreme",
        runs,
      }),
    )
  })
})
