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

// Locale-independent right-panel toggle. The shared `openRightPanel` helper
// looks up the button by English aria name and would not find it after the
// snap switches the app to zh.
async function ensureRightPanelOpen(page: import("@playwright/test").Page) {
  const toggle = page.locator('[aria-controls="right-panel"]').first()
  await toggle.waitFor({ state: "visible", timeout: 30_000 })
  const expanded = await toggle.getAttribute("aria-expanded")
  if (expanded === "true") return
  await toggle.click()
  await page.locator('#right-panel').waitFor({ state: "visible", timeout: 5_000 })
}

// 768px matches the Electron window minWidth from packages/desktop-electron/src/main/windows.ts.
// The placeholder element has `truncate whitespace-nowrap`, so the narrow shot is the only
// way to catch the `/ for commands` hint being clipped at the smallest supported window.
// The "squeezed" row also opens the right panel so the prompt width is realistically narrow
// (window minWidth - sidebar - right panel) instead of just window minWidth.
const NARROW_WIDTH = 768

test("prompt-placeholder", async ({ page, project }) => {
  test.setTimeout(180_000)

  await project.open()
  const enShot = await snapComposer(page, "en-1440")

  await page.setViewportSize({ width: NARROW_WIDTH, height: 900 })
  const enNarrowShot = await snapComposer(page, "en-768")

  await ensureRightPanelOpen(page)
  const enSqueezedShot = await snapComposer(page, "en-768+rightpanel")

  // Client-side locale is sourced from localStorage. Set it, reload, re-snap all widths.
  await page.evaluate(() => {
    localStorage.setItem("pawwork.global.dat:language", JSON.stringify({ locale: "zh" }))
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.reload()
  const zhShot = await snapComposer(page, "zh-1440")

  await page.setViewportSize({ width: NARROW_WIDTH, height: 900 })
  const zhNarrowShot = await snapComposer(page, "zh-768")

  await ensureRightPanelOpen(page)
  const zhSqueezedShot = await snapComposer(page, "zh-768+rightpanel")

  const out = snapOutputPath("prompt-placeholder")
  await composeGrid(
    [enShot, enNarrowShot, enSqueezedShot, zhShot, zhNarrowShot, zhSqueezedShot],
    out,
  )
  process.stdout.write(`\n[snap] prompt-placeholder grid -> ${out}\n\n`)
})
