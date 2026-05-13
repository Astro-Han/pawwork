import fs from "node:fs/promises"
import path from "node:path"
import { test, expect } from "../fixtures"
import { withSession } from "../actions"
import { promptSelector, sessionMessageItemSelector, sessionTurnListSelector, scrollViewportSelector } from "../selectors"
import { sessionPath } from "../utils"
import { installPerfProbe, resetPerfProbe, snapshotPerfProbe, summarizeScenarioRuns } from "./probe"

const outputPath = process.env.PAWWORK_PERF_OUTPUT ?? path.join(process.cwd(), "e2e", "perf-results", "pr0.1-baseline.json")

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

const scenarioResults: ReturnType<typeof summarizeScenarioRuns>[] = []

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
  await expect.poll(async () => (await readPromptSend(page)).started, { timeout: 10_000 }).toBeGreaterThan(previous.started)
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

test.describe("PR0.1 perf probe baseline", () => {
  test.describe.configure({ mode: "serial" })

  test.afterAll(async () => {
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, `${JSON.stringify(scenarioResults, null, 2)}\n`)
  })

  test("homepage-cold emits a 3-run JSON baseline", async ({ page, project }) => {
    await installPerfProbe(page)
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
    }

    scenarioResults.push(summarizeScenarioRuns({ branch: "dev", scenario: "homepage-cold", runs }))
  })

  test("session-streaming-long emits a 3-run JSON baseline", async ({ page, project, assistant }) => {
    await installPerfProbe(page)
    await project.open()

    const runs = []
    for (let run = 0; run < 3; run += 1) {
      const hold = deferred()
      await navigateProjectHome(page, project.directory)
      await assistant.hold(longMarkdown, hold.promise)
      const send = project.prompt(`Stream probe ${run + 1}`)
      await expect.poll(() => page.url(), { timeout: 30_000 }).toContain("/session/")
      await expect(page.locator(sessionMessageItemSelector).last()).toBeVisible({ timeout: 30_000 })
      await resetPerfProbe(page, "session-streaming-long")
      await page.getByRole("button", { name: "Right utility panel" }).click()
      await settleFrames(page, 6)
      hold.resolve()
      await send
      runs.push(await snapshotPerfProbe(page))
    }

    scenarioResults.push(summarizeScenarioRuns({ branch: "dev", scenario: "session-streaming-long", runs }))
  })

  test("tool-call-expand emits a 3-run JSON baseline", async ({ page, project, llm }) => {
    await installPerfProbe(page)
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
      const trigger = page.locator('[data-slot="collapsible-trigger"]').filter({ has: page.locator('[data-component="tool-trigger"]') }).first()
      await expect(trigger).toBeVisible({ timeout: 30_000 })
      await resetPerfProbe(page, "tool-call-expand")
      await trigger.click()
      await expect(trigger).toHaveAttribute("aria-expanded", "true")
      await trigger.click()
      await expect(trigger).toHaveAttribute("aria-expanded", "false")
      await trigger.click()
      await expect(trigger).toHaveAttribute("aria-expanded", "true")
      await settleFrames(page, 4)
      runs.push(await snapshotPerfProbe(page))
    }

    scenarioResults.push(summarizeScenarioRuns({ branch: "dev", scenario: "tool-call-expand", runs }))
  })

  test("session-scroll-reading emits a 3-run JSON baseline", async ({ page, project }) => {
    await installPerfProbe(page)
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
        await resetPerfProbe(page, "session-scroll-reading")
        await page.locator(scrollViewportSelector).first().hover()
        await page.mouse.wheel(0, -3600)
        await settleFrames(page, 2)
        await scrollTimelineTo(page, 0)
        await settleFrames(page, 2)
        await page.mouse.wheel(0, 3600)
        await settleFrames(page, 4)
        runs.push(await snapshotPerfProbe(page))
      })
    }

    scenarioResults.push(summarizeScenarioRuns({ branch: "dev", scenario: "session-scroll-reading", runs }))
  })
})
