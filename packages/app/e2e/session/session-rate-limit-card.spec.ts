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

  // Seed a successful turn first so the session, provider registry, and the
  // app's local-session-ready signal all reach a known-good state. Without it,
  // submitting a brand-new session whose only LLM response is a 429 leaves the
  // UI stuck on "loading prompt" (provider/local-ready never settle).
  await assistant.reply("seed ok")
  await project.open()
  await project.prompt("Seed prompt to warm provider registry.")

  // Sanity: seed turn must render before we trigger the second turn.
  const seedUserText = page.locator('[data-slot="user-message-text"]')
  await expect(seedUserText.first()).toBeVisible({ timeout: 30_000 })

  // Queue the 429 and trigger a second turn via SDK so we don't depend on the
  // UI submit polling the rate-limit response.
  await assistant.error(429, { error: { type: "FreeUsageLimitError" } })
  const sessionID = await page.evaluate(() => {
    const match = /\/session\/([^/?#]+)/.exec(window.location.pathname)
    return match?.[1] ?? ""
  })
  if (!sessionID) throw new Error("could not derive sessionID from page url")

  await project.sdk.session.prompt({
    sessionID,
    parts: [{ type: "text", text: "Trigger rate limit on second turn." }],
  })

  await expect
    .poll(
      async () =>
        project.sdk.session
          .status()
          .then((res) => res.data?.[sessionID]?.type ?? "")
          .catch(() => ""),
      { timeout: 30_000 },
    )
    .toBe("rate_limit_blocked")

  const card = page.locator('[data-slot="rate-limit-card"]')
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card).toContainText("额度")

  // §5.5 P1 invariant: composer must NOT lock when status is rate_limit_blocked.
  const composer = page.locator(promptSelector).first()
  await expect(composer).toHaveAttribute("contenteditable", "true")
  await expect(composer).toHaveAttribute("aria-disabled", "false")

  const subscribe = card.locator('[data-slot="rate-limit-card-subscribe"]')
  const byo = card.locator('[data-slot="rate-limit-card-byo"]')
  await expect(subscribe).toBeVisible()
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

  // BYO click should open Settings; the openSettings("providers") plumbing is
  // covered by the unit tests in Task 9 — here we only assert Settings opens.
  const settingsPage = page.locator('[data-component="settings-page"]')
  await expect(settingsPage).toBeVisible({ timeout: 10_000 })
})
