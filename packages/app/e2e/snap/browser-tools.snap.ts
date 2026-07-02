import { expect, type Locator } from "@playwright/test"
import { fileURLToPath } from "node:url"
import { test } from "../fixtures"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 900, height: 720 }, deviceScaleFactor: 2 })

const LANGUAGE_KEY = "pawwork.global.dat:language"
const TITLE_SHIMMER = '[data-slot="basic-tool-tool-title"] [data-component="text-shimmer"]'
const fixturePath = fileURLToPath(new URL("./fixtures/browser-tools-snap-fixture.tsx", import.meta.url))

async function captureBlock(name: string, block: Locator): Promise<Shot> {
  await expect(block).toBeVisible({ timeout: 30_000 })
  return { name, buf: await block.screenshot() }
}

test("browser-tools", async ({ page }) => {
  test.setTimeout(180_000)

  await page.addInitScript((key) => {
    localStorage.setItem(key, JSON.stringify({ locale: "zh" }))
  }, LANGUAGE_KEY)

  await page.goto("/")
  await page.waitForFunction(
    () => getComputedStyle(document.documentElement).getPropertyValue("--bg-base").trim().length > 0,
    null,
    { timeout: 30_000 },
  )
  await page.evaluate(async (path) => {
    const mod = await import(path)
    mod.mountBrowserToolsSnapFixture(document.body)
  }, `/@fs/${fixturePath}`)

  const shots: Shot[] = []

  const cards = page.locator('[data-snap="browser-cards"]')
  for (const title of ["打开页面", "读取页面结构", "点击", "输入", "等待页面", "截图", "提取页面内容"]) {
    await expect(cards).toContainText(title, { timeout: 30_000 })
  }

  // navigate renders a clickable link, like webfetch.
  const navigateLink = cards.locator('[data-card="browser-navigate"] a[data-slot="basic-tool-tool-subtitle"]')
  await expect(navigateLink).toHaveAttribute("href", "https://example.com/pricing", { timeout: 30_000 })

  // click/type/wait show the literal target as subtitle.
  await expect(cards.locator('[data-card="browser-click"]')).toContainText("e12", { timeout: 30_000 })
  await expect(cards.locator('[data-card="browser-type"]')).toContainText("e7", { timeout: 30_000 })
  await expect(cards.locator('[data-card="browser-wait"]')).toContainText("Thanks for signing up", {
    timeout: 30_000,
  })

  // snapshot/extract expand to the text the agent read.
  await expect(cards.locator('[data-card="browser-snapshot"] [data-component="bash-output"]')).toContainText(
    "[ref=e12]",
    { timeout: 30_000 },
  )
  await expect(cards.locator('[data-card="browser-extract"] [data-component="bash-output"]')).toContainText(
    "Simple plans for every team",
    { timeout: 30_000 },
  )
  shots.push(await captureBlock("browser-cards", cards))

  // running navigate shimmers and must not render a link yet.
  const running = page.locator('[data-snap="browser-running"]')
  await expect(running.locator(`${TITLE_SHIMMER}[data-active="true"]`)).toBeVisible({ timeout: 30_000 })
  await expect(running.locator("a")).toHaveCount(0)
  shots.push(await captureBlock("browser-running", running))

  // collapsed trow groups browser steps under one summary line.
  const trow = page.locator('[data-snap="browser-trow-collapsed"]')
  await expect(trow).toContainText("浏览器操作 7 步", { timeout: 30_000 })
  shots.push(await captureBlock("browser-trow-collapsed", trow))

  const out = snapOutputPath("browser-tools")
  await composeGrid(shots, out, { cols: 1 })
  process.stdout.write(`\n[snap] browser-tools grid -> ${out}\n\n`)
})
