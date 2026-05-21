import { test, expect } from "../fixtures"
import { routeTurnChangeDiff, TURN_CHANGE_DIFF_FILE_PATH } from "./turn-change-diff-fixture"

test("turn-change file rows reserve diff height before rendering", async ({ page, llm, project }) => {
  test.setTimeout(180_000)

  await page.addInitScript(() => {
    const state = { total: 0 }
    Object.defineProperty(window, "__turnChangeCls", { value: state })
    if (typeof PerformanceObserver === "undefined") return
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as Array<
          PerformanceEntry & { value?: number; hadRecentInput?: boolean }
        >) {
          if (entry.hadRecentInput || typeof entry.value !== "number") continue
          state.total += entry.value
        }
      })
      observer.observe({ type: "layout-shift", buffered: true })
    } catch {}
  })

  await project.open()
  await routeTurnChangeDiff(page, { sessionID: "e2e-session" })

  await llm.text("seeded turn-change diff")
  await project.prompt(`seed turn-change diff ${Date.now()}`)

  const card = page.locator('[data-slot="session-turn-changes"]').last()
  await expect(card).toBeVisible({ timeout: 30_000 })
  const row = card
    .locator('[data-slot="session-turn-change-row"]')
    .filter({ hasText: TURN_CHANGE_DIFF_FILE_PATH })
    .first()
  await expect(row).toBeVisible()

  await page.evaluate(() => {
    const state = (window as unknown as { __turnChangeCls?: { total: number } }).__turnChangeCls
    if (state) state.total = 0
  })

  for (const _ of [0, 1, 2]) {
    await row.click()
    const diff = card.locator('[data-slot="session-turn-change-diff"]').first()
    await expect(diff).toBeVisible()
    await expect
      .poll(async () => await diff.evaluate((el) => Number.parseFloat(getComputedStyle(el).minHeight)), {
        timeout: 10_000,
      })
      .toBeGreaterThan(0)
    await expect(diff.locator("[data-line]").first()).toBeVisible({ timeout: 30_000 })
    await row.click()
    await expect(diff).toHaveCount(0)
  }

  const cls = await page.evaluate(
    () => (window as unknown as { __turnChangeCls?: { total: number } }).__turnChangeCls?.total ?? 0,
  )
  expect(cls).toBeLessThan(0.1)
})
