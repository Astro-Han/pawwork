import { expect, type Locator } from "@playwright/test"
import { fileURLToPath } from "node:url"
import { test } from "../fixtures"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 900, height: 560 }, deviceScaleFactor: 2 })

const LANGUAGE_KEY = "pawwork.global.dat:language"
const fixturePath = fileURLToPath(new URL("../../src/testing/trow-snap-fixture.tsx", import.meta.url))
async function captureBlock(name: string, block: Locator): Promise<Shot> {
  await expect(block).toBeVisible({ timeout: 30_000 })
  return { name, buf: await block.screenshot() }
}

async function waitForThemeBoot(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForFunction(
    () => getComputedStyle(document.documentElement).getPropertyValue("--bg-base").trim().length > 0,
    null,
    { timeout: 30_000 },
  )
}

test("session-trow", async ({ page }) => {
  test.setTimeout(180_000)

  await page.addInitScript((key) => {
    localStorage.setItem(key, JSON.stringify({ locale: "zh" }))
  }, LANGUAGE_KEY)

  await page.goto("/")
  await waitForThemeBoot(page)
  await page.evaluate(async (path) => {
    const mod = await import(path)
    mod.mountTrowSnapFixture(document.body)
  }, `/@fs/${fixturePath}`)

  const shots: Shot[] = []
  const running = page.locator('[data-snap="running-current"]')
  await expect(running).toContainText("执行命令 third command", { timeout: 30_000 })
  shots.push(await captureBlock("running-current", running))

  shots.push(await captureBlock("mixed-collapsed", page.locator('[data-snap="mixed-collapsed"]')))

  const collapsedFollowedByText = page.locator('[data-snap="collapsed-followed-by-text"]')
  const collapsedTextGap = await collapsedFollowedByText.evaluate((root) => {
    const trow = root.querySelector<HTMLElement>('[data-component="session-turn-trow-block"]')
    const text = root.querySelector<HTMLElement>('[data-component="text-part"]')
    if (!trow || !text) return Number.NaN
    return text.getBoundingClientRect().top - trow.getBoundingClientRect().bottom
  })
  expect(collapsedTextGap).toBeGreaterThanOrEqual(0)
  expect(collapsedTextGap).toBeLessThanOrEqual(12)
  shots.push(await captureBlock("collapsed-followed-by-text", collapsedFollowedByText))

  shots.push(await captureBlock("mixed-expanded", page.locator('[data-snap="mixed-expanded"]')))
  await expect(page.locator('[data-snap="inner-bash-expanded"] [data-component="bash-output"]')).toBeVisible({
    timeout: 30_000,
  })
  shots.push(await captureBlock("inner-bash-expanded", page.locator('[data-snap="inner-bash-expanded"]')))

  const toolOutputSpacing = page.locator('[data-snap="tool-output-spacing"]')
  await expect(toolOutputSpacing.locator('[data-component="tool-output"]')).toBeVisible({ timeout: 30_000 })
  const toolOutputMetrics = await toolOutputSpacing.evaluate((root) => {
    const output = root.querySelector<HTMLElement>('[data-component="tool-output"]')
    const lastContent =
      output?.querySelector<HTMLElement>('[data-component="markdown"] > :last-child') ??
      output?.querySelector<HTMLElement>("pre") ??
      output
    const triggers = root.querySelectorAll<HTMLElement>('[data-slot="collapsible-trigger"]')
    const nextTrigger = triggers[1]
    if (!output || !lastContent || !nextTrigger) return { outputGap: Number.NaN, contentGap: Number.NaN }
    return {
      outputGap: nextTrigger.getBoundingClientRect().top - output.getBoundingClientRect().bottom,
      contentGap: nextTrigger.getBoundingClientRect().top - lastContent.getBoundingClientRect().bottom,
    }
  })
  expect(toolOutputMetrics.outputGap).toBeGreaterThanOrEqual(0)
  expect(toolOutputMetrics.outputGap).toBeLessThanOrEqual(8)
  expect(toolOutputMetrics.contentGap).toBeGreaterThanOrEqual(0)
  expect(toolOutputMetrics.contentGap).toBeLessThanOrEqual(8)
  const toolOutputUserSelect = await toolOutputSpacing.evaluate((root) => {
    const summary = root.querySelector<HTMLElement>('[data-slot="trow-summary"]')
    const trigger = root.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')
    const output = root.querySelector<HTMLElement>('[data-component="tool-output"]')
    return {
      summary: summary ? getComputedStyle(summary).userSelect : "",
      trigger: trigger ? getComputedStyle(trigger).userSelect : "",
      output: output ? getComputedStyle(output).userSelect : "",
    }
  })
  expect(toolOutputUserSelect.summary).toBe("text")
  expect(toolOutputUserSelect.trigger).toBe("text")
  expect(toolOutputUserSelect.output).toBe("text")
  shots.push(await captureBlock("tool-output-spacing", toolOutputSpacing))

  const registeredToolRows = page.locator('[data-snap="registered-tool-rows"]')
  await expect(registeredToolRows).toContainText("网络搜索", { timeout: 30_000 })
  await expect(registeredToolRows).toContainText("进入工作树", { timeout: 30_000 })
  await expect(registeredToolRows).toContainText("learn-code", { timeout: 30_000 })
  const registeredMetrics = await registeredToolRows.evaluate((root) => {
    const titleSelectors = ['[data-slot="basic-tool-tool-title"]', '[data-component="task-tool-title"]']
    const titles = titleSelectors.flatMap((selector) =>
      Array.from(root.querySelectorAll<HTMLElement>(selector), (el) => ({
        text: el.textContent?.trim() ?? "",
        left: el.getBoundingClientRect().left,
      })),
    )
    const output = root.querySelector<HTMLElement>('[data-component="exa-tool-output"]')
    const triggers = Array.from(root.querySelectorAll<HTMLElement>('[data-slot="collapsible-trigger"]'))
    const nextTrigger = triggers[1]
    return {
      titleLefts: titles.filter((item) => item.text).map((item) => item.left),
      webSearchOutputGap:
        output && nextTrigger ? nextTrigger.getBoundingClientRect().top - output.getBoundingClientRect().bottom : Number.NaN,
    }
  })
  expect(registeredMetrics.titleLefts.length).toBeGreaterThanOrEqual(5)
  expect(Math.max(...registeredMetrics.titleLefts) - Math.min(...registeredMetrics.titleLefts)).toBeLessThanOrEqual(1)
  expect(registeredMetrics.webSearchOutputGap).toBeGreaterThanOrEqual(0)
  expect(registeredMetrics.webSearchOutputGap).toBeLessThanOrEqual(8)
  shots.push(await captureBlock("registered-tool-rows", registeredToolRows))

  const singleDirect = page.locator('[data-snap="single-command-direct"]')
  await expect(singleDirect.locator('[data-component="session-turn-trow-block"][data-single]')).toBeVisible({
    timeout: 30_000,
  })
  await expect(singleDirect.locator('[data-component="bash-output"]')).toBeVisible({ timeout: 30_000 })
  shots.push(await captureBlock("single-command-direct", singleDirect))

  const singleExpanded = page.locator('[data-snap="single-command-expanded"]')
  await expect(singleExpanded.locator('[data-component="session-turn-trow-block"][data-single]')).toBeVisible({
    timeout: 30_000,
  })
  await expect(singleExpanded.locator('[data-component="bash-output"]')).toBeVisible({
    timeout: 30_000,
  })
  shots.push(await captureBlock("single-command-expanded", singleExpanded))

  const singleRunning = page.locator('[data-snap="single-command-running"]')
  await expect(singleRunning.locator('[data-component="session-turn-trow-block"][data-single]')).toBeVisible({
    timeout: 30_000,
  })
  await expect(singleRunning).toContainText("执行命令", { timeout: 30_000 })
  shots.push(await captureBlock("single-command-running", singleRunning))

  const out = snapOutputPath("session-trow")
  await composeGrid(shots, out, { cols: 2 })
  process.stdout.write(`\n[snap] session-trow grid -> ${out}\n\n`)
})
