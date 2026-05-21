import { test } from "../fixtures"
import { promptSelector } from "../selectors"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

async function snapComposer(page: import("@playwright/test").Page, name: string): Promise<Shot> {
  const prompt = page.locator(promptSelector)
  await prompt.waitFor({ state: "visible", timeout: 30_000 })
  const placeholder = page.locator('[data-component="prompt-placeholder"]')
  await placeholder.waitFor({ state: "visible", timeout: 30_000 })
  return { name, buf: await prompt.screenshot() }
}

// 768px matches the Electron window minWidth from packages/desktop-electron/src/main/windows.ts.
// The placeholder element has `truncate whitespace-nowrap`, so the narrow shot is the only
// way to catch the `/ for commands` hint being clipped at the smallest supported window.
const NARROW_WIDTH = 768

test("prompt-placeholder", async ({ page, project }) => {
  test.setTimeout(180_000)

  await project.open()
  const enShot = await snapComposer(page, "en-1440")

  await page.setViewportSize({ width: NARROW_WIDTH, height: 900 })
  const enNarrowShot = await snapComposer(page, "en-768")

  // Client-side locale is sourced from localStorage. Set it, reload, re-snap both widths.
  await page.evaluate(() => {
    localStorage.setItem("pawwork.global.dat:language", JSON.stringify({ locale: "zh" }))
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.reload()
  const zhShot = await snapComposer(page, "zh-1440")

  await page.setViewportSize({ width: NARROW_WIDTH, height: 900 })
  const zhNarrowShot = await snapComposer(page, "zh-768")

  const out = snapOutputPath("prompt-placeholder")
  await composeGrid([enShot, enNarrowShot, zhShot, zhNarrowShot], out)
  process.stdout.write(`\n[snap] prompt-placeholder grid -> ${out}\n\n`)
})
