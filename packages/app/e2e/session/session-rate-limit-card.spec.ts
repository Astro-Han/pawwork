import { test, expect } from "../fixtures"
import { promptSelector } from "../selectors"

const LANGUAGE_KEY = "pawwork.global.dat:language"

test("rate_limit_blocked renders RateLimitCard, keeps composer unlocked, BYO opens Providers tab", async ({
  page,
  project,
  assistant,
}) => {
  await page.addInitScript((key) => {
    localStorage.setItem(key, JSON.stringify({ locale: "zh" }))
  }, LANGUAGE_KEY)

  const events: { name: string; payload: unknown }[] = []
  page.on("console", (msg) => {
    if (msg.type() !== "info") return
    const text = msg.text()
    if (!text.startsWith("[pawwork:event] rate_limit_card.")) return
    const args = msg.args()
    if (args.length >= 3) {
      Promise.all([args[1].jsonValue(), args[2].jsonValue()])
        .then(([name, payload]) => events.push({ name: String(name), payload }))
        .catch(() => undefined)
    }
  })

  // Brand-new session: only LLM response is a 429 FreeUsageLimitError.
  // Verifies the §5.5 invariant that rate_limit_blocked unlocks composer and
  // renders RateLimitCard even on first-turn (no prior successful turn).
  await assistant.error(429, { error: { type: "FreeUsageLimitError" } })
  await project.open()
  await project.prompt("First turn that should hit rate limit.")

  const card = page.locator('[data-slot="rate-limit-card"]')
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card).toContainText("额度")

  // §5.5 P1 invariant: composer must NOT lock when status is rate_limit_blocked.
  const composer = page.locator(promptSelector).first()
  await expect(composer).toHaveAttribute("contenteditable", "true")
  await expect(composer).toHaveAttribute("aria-disabled", "false")

  const subscribe = card.locator('[data-slot="rate-limit-card-subscribe"]')
  const deepseek = card.locator('[data-slot="rate-limit-card-deepseek"]')
  const byo = card.locator('[data-slot="rate-limit-card-byo"]')
  await expect(subscribe).toBeVisible()
  await expect(deepseek).toBeVisible()
  await expect(byo).toBeVisible()

  await subscribe.click()
  await expect
    .poll(() => events.find((e) => e.name === "rate_limit_card.subscribe_click")?.name)
    .toBe("rate_limit_card.subscribe_click")
  expect(events.find((e) => e.name === "rate_limit_card.subscribe_click")?.payload).toMatchObject({
    providerID: "opencode",
  })

  await byo.click()
  await expect
    .poll(() => events.find((e) => e.name === "rate_limit_card.byo_click")?.name)
    .toBe("rate_limit_card.byo_click")

  await deepseek.click()
  await expect
    .poll(() => events.find((e) => e.name === "rate_limit_card.deepseek_click")?.name)
    .toBe("rate_limit_card.deepseek_click")
  expect(events.find((e) => e.name === "rate_limit_card.deepseek_click")?.payload).toMatchObject({
    providerID: "opencode",
  })

  // BYO click should open Settings; the openSettings("providers") plumbing is
  // covered by the unit tests in Task 9 — here we only assert Settings opens.
  const settingsPage = page.locator('[data-component="settings-page"]')
  await expect(settingsPage).toBeVisible({ timeout: 10_000 })
})
