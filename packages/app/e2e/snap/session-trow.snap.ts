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
  shots.push(await captureBlock("mixed-expanded", page.locator('[data-snap="mixed-expanded"]')))
  await expect(page.locator('[data-snap="inner-bash-expanded"] [data-component="bash-output"]')).toBeVisible({
    timeout: 30_000,
  })
  shots.push(await captureBlock("inner-bash-expanded", page.locator('[data-snap="inner-bash-expanded"]')))
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
