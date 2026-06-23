import { test, expect } from "../fixtures"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

const LANGUAGE_KEY = "pawwork.global.dat:language"
const stored = (locale: "en" | "zh") => JSON.stringify({ locale })

// Visual review of the unified error card on the real render path, for the
// representative must-act kind (quota_exhausted: red rule + primary action +
// detail). Captured collapsed then with the provider reason disclosed, in both
// locales the app renders at runtime: zh (the localized copy) and en (the base
// every other locale, including the 14 untranslated ones, falls back to). zht
// parity is covered by the i18n unit tests (error-card-title.test.ts).
test("error-card", async ({ page, project, assistant }) => {
  test.setTimeout(180_000)

  // Seed zh only when nothing is stored, so the en override below survives the
  // reload (addInitScript re-runs on every navigation, including reload).
  await page.addInitScript((key) => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ locale: "zh" }))
  }, LANGUAGE_KEY)

  await assistant.error(402, {
    error: { message: "Insufficient Balance", code: "invalid_request_error", type: "unknown_error" },
  })
  await project.open()
  await project.prompt("Trigger a quota error.")

  const shots: Shot[] = []
  const capture = async (locale: "en" | "zh") => {
    const card = page.locator('[data-kind="error-card"]').first()
    await card.waitFor({ state: "visible", timeout: 30_000 })
    shots.push({ name: `${locale}-collapsed`, buf: await card.screenshot() })
    await card.locator('[data-slot="collapsible-trigger"]').click()
    await expect(card.locator('[data-slot="error-card-reason"]')).toBeVisible()
    shots.push({ name: `${locale}-detail`, buf: await card.screenshot() })
  }

  await capture("zh")

  // Switch to the English base copy and reload; the session route (and its
  // backend-persisted error) survives, so the same card re-renders in en.
  await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: LANGUAGE_KEY, value: stored("en") })
  await page.reload()
  await capture("en")

  const out = snapOutputPath("error-card")
  await composeGrid(shots, out, { cols: 2 })
  process.stdout.write(`\n[snap] error-card grid -> ${out}\n\n`)
})
