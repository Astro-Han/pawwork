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

  // Seed a successful turn so provider registry + local-ready signals settle
  // before the rate-limit turn (otherwise the UI stays on "loading prompt").
  await assistant.reply("seed ok")
  await project.open()
  await project.prompt("Seed prompt to warm provider registry.")
  await expect(page.locator('[data-slot="user-message-text"]').first()).toBeVisible({ timeout: 30_000 })

  await assistant.error(429, { error: { type: "FreeUsageLimitError" } })
  const sessionID = await page.evaluate(() => {
    const match = /\/session\/([^/?#]+)/.exec(window.location.pathname)
    return match?.[1] ?? ""
  })
  if (!sessionID) throw new Error("could not derive sessionID from page url")

  await project.sdk.session.prompt({
    sessionID,
    parts: [{ type: "text", text: "Trigger rate limit for snap." }],
  })

  const card = page.locator('[data-slot="rate-limit-card"]').first()
  await card.waitFor({ state: "visible", timeout: 30_000 })

  const shots: Shot[] = [{ name: "zh", buf: await card.screenshot() }]
  const out = snapOutputPath("rate-limit-card")
  await composeGrid(shots, out)
  process.stdout.write(`\n[snap] rate-limit-card grid -> ${out}\n\n`)
})
