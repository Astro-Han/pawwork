import { test, expect } from "../fixtures"

const LANGUAGE_KEY = "pawwork.global.dat:language"

// End-to-end proof of the original trigger bug's fix: DeepSeek direct with an
// account in arrears returns 402 "Insufficient Balance". The backend classifies
// it as quota_exhausted (PR1) and no longer overwrites the reason with
// "Connection lost" (PR2); the per-kind card shows plain copy, tucks the real
// provider reason into its detail, and its action opens the models settings tab.
test("quota_exhausted renders the per-kind error card, discloses the real reason, opens settings", async ({
  page,
  project,
  assistant,
}) => {
  await page.addInitScript((key) => {
    localStorage.setItem(key, JSON.stringify({ locale: "zh" }))
  }, LANGUAGE_KEY)

  await assistant.error(402, {
    error: { message: "Insufficient Balance", code: "invalid_request_error", type: "unknown_error" },
  })
  await project.open()
  await project.prompt("Trigger a quota error.")

  const card = page.locator('[data-kind="error-card"]')
  await expect(card).toBeVisible({ timeout: 30_000 })
  // Title keyed by providerFailure.kind, not the raw reason.
  await expect(card).toContainText("余额不足")

  // The body is the plain-language copy; the raw provider reason must NOT leak
  // into it (it belongs in the detail). Asserting both directions, so a
  // regression that renders the reason as the body would fail here.
  const body = card.locator('[data-slot="card-description"]')
  await expect(body).toContainText("到对应服务商充值")
  await expect(body).not.toContainText("Insufficient Balance")

  // The provider's verbatim reason lives in the collapsed detail, not the body.
  const reason = card.locator('[data-slot="error-card-reason"]')
  await expect(reason).toBeHidden()
  await card.locator('[data-slot="collapsible-trigger"]').click()
  await expect(reason).toContainText("Insufficient Balance")

  // The primary action ("换个模型") opens settings on the models tab specifically,
  // not just any settings page (a regression to another tab would still show it).
  await card.locator('[data-slot="error-card-action"]').click()
  await expect(page.locator('[data-component="settings-page"]')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('[data-action="settings-tab-models"]')).toHaveAttribute("aria-selected", "true")
})

// `unknown` (here a 404 the classifier maps to unknown) has no plain copy, so the
// provider's raw reason becomes the body. That text is unbounded, so the body
// must stay height-capped and scroll — it must not stretch the timeline open.
test("unknown error caps the raw-reason body height instead of blowing up the timeline", async ({
  page,
  project,
  assistant,
}) => {
  const longReason = ("This is a very long provider error reason. ".repeat(120)).trim()
  await assistant.error(404, {
    error: { message: longReason, code: "unknown_error", type: "unknown_error" },
  })
  await project.open()
  await project.prompt("Trigger an unknown error.")

  const card = page.locator('[data-kind="error-card"]')
  await expect(card).toBeVisible({ timeout: 30_000 })

  // The raw reason is the body (no plain copy for unknown), capped at 240px.
  const body = card.locator('[data-slot="card-description"].error-card__raw')
  await expect(body).toContainText("very long provider error reason")
  const box = await body.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.height).toBeLessThanOrEqual(260)
  // And the content genuinely overflows that cap, proving the cap is doing work
  // rather than the text just happening to be short.
  const overflows = await body.evaluate((el) => el.scrollHeight > el.clientHeight + 1)
  expect(overflows).toBe(true)
})
