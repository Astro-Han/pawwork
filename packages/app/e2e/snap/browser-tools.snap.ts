import { expect, type Locator } from "@playwright/test"
import { fileURLToPath } from "node:url"
import { test } from "../fixtures"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 520, height: 420 }, deviceScaleFactor: 2 })

const LANGUAGE_KEY = "pawwork.global.dat:language"
const fixturePath = fileURLToPath(new URL("./fixtures/browser-tools-fixture.tsx", import.meta.url))

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

test("browser-tools", async ({ page }) => {
  test.setTimeout(120_000)

  await page.addInitScript((key) => {
    localStorage.setItem(key, JSON.stringify({ locale: "zh" }))
  }, LANGUAGE_KEY)

  await page.goto("/")
  await waitForThemeBoot(page)
  await page.evaluate(async (path) => {
    const mod = await import(path)
    mod.mountBrowserToolsFixture(document.body)
  }, `/@fs/${fixturePath}`)

  const cards = page.locator('[data-snap="browser-tool-cards"]')
  await expect(cards).toBeVisible({ timeout: 30_000 })

  // Each tool renders its localized title via the shared toolInfoForInput map,
  // not the generic "调用 browser_navigate" fallback.
  await expect(cards).toContainText("打开网页", { timeout: 30_000 })
  await expect(cards).toContainText("网页截图", { timeout: 30_000 })
  await expect(cards).toContainText("提取文本", { timeout: 30_000 })
  await expect(cards).toContainText("等待", { timeout: 30_000 })
  await expect(cards).toContainText("点击", { timeout: 30_000 })
  await expect(cards).toContainText("输入", { timeout: 30_000 })
  // Subtitle carries the call's target (url / selector).
  await expect(cards).toContainText("https://news.ycombinator.com/", { timeout: 30_000 })
  await expect(cards).toContainText("main article", { timeout: 30_000 })
  // The leading "browser" family icon is supplied by the trow summary via
  // toolIcon() (locked separately in tool-info.test.ts); these standalone cards
  // exercise the card title/subtitle content the timeline shows.

  const shots: Shot[] = [await captureBlock("browser-tool-cards", cards)]
  const out = snapOutputPath("browser-tools")
  await composeGrid(shots, out, { cols: 1 })
  process.stdout.write(`\n[snap] browser-tools grid -> ${out}\n\n`)
})
