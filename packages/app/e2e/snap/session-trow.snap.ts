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

  const activitySummary = page.locator('[data-snap="activity-summary-collapsed"]')
  await expect(activitySummary).toContainText("读取 1 个文件，运行 1 条命令，搜索文件 1 次", { timeout: 30_000 })
  await expect(activitySummary).toContainText("使用 1 个工具", { timeout: 30_000 })
  shots.push(await captureBlock("activity-summary-collapsed", activitySummary))

  const failedSummary = page.locator('[data-snap="failed-summary-collapsed"]')
  await expect(failedSummary).toContainText("运行 1 条命令，读取 1 个文件，1 个失败", { timeout: 30_000 })
  shots.push(await captureBlock("failed-summary-collapsed", failedSummary))

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
  const innerBashMetrics = await page.locator('[data-snap="inner-bash-expanded"]').evaluate((root) => {
    const summary = root.querySelector<HTMLElement>('[data-slot="trow-summary"]')
    const body = root.querySelector<HTMLElement>('[data-slot="trow-body"]')
    const pre = root.querySelector<HTMLElement>('[data-component="bash-output"] [data-slot="bash-pre"]')
    const code = pre?.querySelector<HTMLElement>("code")
    const summaryText = root.querySelector<HTMLElement>('[data-slot="trow-summary-text"]')
    const openTool = pre?.closest<HTMLElement>('[data-slot="trow-result-body"]')
    const trigger = openTool?.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')
    const triggerContent = openTool?.querySelector<HTMLElement>('[data-slot="basic-tool-tool-trigger-content"]')
    const arrow = openTool?.querySelector<HTMLElement>('[data-slot="collapsible-arrow"]')
    const content = openTool?.querySelector<HTMLElement>('[data-slot="collapsible-content"]')
    if (!summary || !body || !pre || !code || !summaryText || !trigger || !triggerContent || !arrow || !content) {
      return {
        bodyTopGap: Number.NaN,
        rowGap: "",
        prePadding: "",
        codeFontSize: "",
        codeLineHeight: "",
        summaryWhiteSpace: "",
        triggerCursor: "",
        arrowGap: Number.NaN,
        contentGap: Number.NaN,
        contentTransitionProperty: "",
      }
    }
    return {
      bodyTopGap: Math.round(body.getBoundingClientRect().top - summary.getBoundingClientRect().bottom),
      rowGap: getComputedStyle(body).rowGap,
      prePadding: getComputedStyle(pre).padding,
      codeFontSize: getComputedStyle(code).fontSize,
      codeLineHeight: getComputedStyle(code).lineHeight,
      summaryWhiteSpace: getComputedStyle(summaryText).whiteSpace,
      triggerCursor: getComputedStyle(trigger).cursor,
      arrowGap: Math.round(arrow.getBoundingClientRect().left - triggerContent.getBoundingClientRect().right),
      contentGap: Math.round(content.getBoundingClientRect().top - trigger.getBoundingClientRect().bottom),
      contentTransitionProperty: getComputedStyle(content).transitionProperty,
    }
  })
  expect(innerBashMetrics.bodyTopGap).toBeGreaterThanOrEqual(0)
  expect(innerBashMetrics.bodyTopGap).toBeLessThanOrEqual(5)
  expect(innerBashMetrics.rowGap).toBe("4px")
  expect(innerBashMetrics.prePadding).toBe("8px 10px")
  expect(innerBashMetrics.codeFontSize).toBe("12px")
  expect(innerBashMetrics.codeLineHeight).toBe("18px")
  expect(innerBashMetrics.summaryWhiteSpace).toBe("nowrap")
  expect(innerBashMetrics.triggerCursor).toBe("text")
  expect(innerBashMetrics.arrowGap).toBe(8)
  expect(innerBashMetrics.contentGap).toBe(4)
  expect(innerBashMetrics.contentTransitionProperty).toContain("height")
  expect(innerBashMetrics.contentTransitionProperty).toContain("content-visibility")
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
    const firstTrigger = triggers[0]
    const nextTrigger = triggers[1]
    if (!output || !lastContent || !firstTrigger || !nextTrigger) {
      return { outputGap: Number.NaN, contentGap: Number.NaN, triggerOutputGap: Number.NaN }
    }
    return {
      outputGap: nextTrigger.getBoundingClientRect().top - output.getBoundingClientRect().bottom,
      contentGap: nextTrigger.getBoundingClientRect().top - lastContent.getBoundingClientRect().bottom,
      triggerOutputGap: output.getBoundingClientRect().top - firstTrigger.getBoundingClientRect().bottom,
    }
  })
  expect(toolOutputMetrics.outputGap).toBeGreaterThanOrEqual(0)
  expect(toolOutputMetrics.outputGap).toBeLessThanOrEqual(8)
  expect(toolOutputMetrics.contentGap).toBeGreaterThanOrEqual(0)
  expect(toolOutputMetrics.contentGap).toBeLessThanOrEqual(8)
  expect(Math.round(toolOutputMetrics.triggerOutputGap)).toBe(4)
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
  await expect(registeredToolRows).toContainText("使用技能", { timeout: 30_000 })
  await expect(registeredToolRows).toContainText("learn-code", { timeout: 30_000 })
  await expect(registeredToolRows).toContainText("提出问题", { timeout: 30_000 })
  await expect(registeredToolRows).toContainText("1 已回答", { timeout: 30_000 })
  await expect(registeredToolRows).not.toContainText("你想继续深入测试某个工具吗?", { timeout: 30_000 })
  await expect(registeredToolRows).not.toContainText("够了", { timeout: 30_000 })
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

  const questionExpanded = page.locator('[data-snap="question-expanded"]')
  await expect(questionExpanded).toContainText("提出问题", { timeout: 30_000 })
  await expect(questionExpanded).toContainText("你想继续深入测试某个工具吗?", { timeout: 30_000 })
  await expect(questionExpanded).toContainText("够了", { timeout: 30_000 })
  const questionMetrics = await questionExpanded.evaluate((root) => {
    const answers = root.querySelector<HTMLElement>('[data-component="question-answers"]')
    const item = root.querySelector<HTMLElement>('[data-slot="question-answer-item"]')
    const question = root.querySelector<HTMLElement>('[data-slot="question-text"]')
    if (!answers || !item || !question) {
      return { listGap: "", itemGap: "", fontSize: "", lineHeight: "" }
    }
    return {
      listGap: getComputedStyle(answers).rowGap,
      itemGap: getComputedStyle(item).rowGap,
      fontSize: getComputedStyle(question).fontSize,
      lineHeight: getComputedStyle(question).lineHeight,
    }
  })
  expect(questionMetrics.listGap).toBe("4px")
  expect(questionMetrics.itemGap).toBe("0px")
  expect(questionMetrics.fontSize).toBe("12px")
  expect(questionMetrics.lineHeight).toBe("18px")
  shots.push(await captureBlock("question-expanded", questionExpanded))

  const singleDirect = page.locator('[data-snap="single-command-direct"]')
  await expect(singleDirect.locator('[data-component="session-turn-trow-block"][data-single]')).toBeVisible({
    timeout: 30_000,
  })
  await expect(singleDirect.locator('[data-slot="trow-summary-icon"]')).toBeVisible({ timeout: 30_000 })
  await expect(singleDirect.locator('[data-component="bash-output"]')).toBeVisible({ timeout: 30_000 })
  shots.push(await captureBlock("single-command-direct", singleDirect))

  const singleExpanded = page.locator('[data-snap="single-command-expanded"]')
  await expect(singleExpanded.locator('[data-component="session-turn-trow-block"][data-single]')).toBeVisible({
    timeout: 30_000,
  })
  await expect(singleExpanded.locator('[data-slot="trow-summary-icon"]')).toBeVisible({ timeout: 30_000 })
  await expect(singleExpanded.locator('[data-component="bash-output"]')).toBeVisible({
    timeout: 30_000,
  })
  shots.push(await captureBlock("single-command-expanded", singleExpanded))

  const singleShellSettingCollapsed = page.locator('[data-snap="single-shell-setting-collapsed"]')
  await expect(singleShellSettingCollapsed).toContainText("执行命令", { timeout: 30_000 })
  await expect(singleShellSettingCollapsed).toContainText("respects shell setting", { timeout: 30_000 })
  await expect(singleShellSettingCollapsed.locator('[data-component="bash-output"]')).toBeHidden({ timeout: 30_000 })
  shots.push(await captureBlock("single-shell-setting-collapsed", singleShellSettingCollapsed))

  const singleShellSettingExpanded = page.locator('[data-snap="single-shell-setting-expanded"]')
  await expect(singleShellSettingExpanded).toContainText("执行命令", { timeout: 30_000 })
  await expect(singleShellSettingExpanded).toContainText("respects shell setting", { timeout: 30_000 })
  await expect(singleShellSettingExpanded.locator('[data-component="bash-output"]')).toBeVisible({ timeout: 30_000 })
  shots.push(await captureBlock("single-shell-setting-expanded", singleShellSettingExpanded))

  const singleRunning = page.locator('[data-snap="single-command-running"]')
  await expect(singleRunning.locator('[data-component="session-turn-trow-block"][data-single]')).toBeVisible({
    timeout: 30_000,
  })
  await expect(singleRunning.locator('[data-slot="trow-summary-icon"]')).toBeVisible({ timeout: 30_000 })
  await expect(singleRunning).toContainText("执行命令", { timeout: 30_000 })
  shots.push(await captureBlock("single-command-running", singleRunning))

  const out = snapOutputPath("session-trow")
  await composeGrid(shots, out, { cols: 2 })
  process.stdout.write(`\n[snap] session-trow grid -> ${out}\n\n`)
})
