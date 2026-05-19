import { test, expect } from "../fixtures"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

const LANGUAGE_KEY = "pawwork.global.dat:language"

test("rate-limit-card", async ({ page, project, assistant }) => {
  test.setTimeout(180_000)

  // Visual review captures the zh rendering; locale-agnostic shape/spacing
  // is what matters. English copy path is exercised by the E2E spec.
  await page.addInitScript((key) => {
    localStorage.setItem(key, JSON.stringify({ locale: "zh" }))
  }, LANGUAGE_KEY)

  await assistant.error(429, { error: { type: "FreeUsageLimitError" } })
  await project.open()
  await project.prompt("First turn that should hit rate limit.")

  const card = page.locator('[data-slot="rate-limit-card"]').first()
  await card.waitFor({ state: "visible", timeout: 30_000 })

  const shots: Shot[] = [
    { name: "zh-card", buf: await card.screenshot() },
    { name: "zh-page", buf: await page.screenshot({ fullPage: false }) },
  ]
  const out = snapOutputPath("rate-limit-card")
  await composeGrid(shots, out)
  process.stdout.write(`\n[snap] rate-limit-card grid -> ${out}\n\n`)
})
