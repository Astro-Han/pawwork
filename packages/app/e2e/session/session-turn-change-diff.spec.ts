import type { Page } from "@playwright/test"
import { test, expect } from "../fixtures"
import {
  routeTurnChangeDiff,
  TURN_CHANGE_MODIFIED_DIFF_FILE_PATH,
  TURN_CHANGE_SMALL_MODIFIED_DIFF_FILE_PATH,
} from "./turn-change-diff-fixture"

async function installClsProbe(page: Page) {
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
}

async function openTurnChangeCard(input: {
  page: Page
  llm: { text: (value: string) => Promise<void> }
  project: {
    open: () => Promise<void>
    prompt: (value: string) => Promise<void>
  }
}) {
  await input.project.open()
  await routeTurnChangeDiff(input.page, { sessionID: "e2e-session" })

  await input.llm.text("seeded turn-change diff")
  await input.project.prompt(`seed turn-change diff ${Date.now()}`)

  const card = input.page.locator('[data-component="session-turn-changes"]').last()
  await expect(card).toBeVisible({ timeout: 30_000 })
  return card
}

async function resetClsProbe(page: Page) {
  await page.evaluate(() => {
    const state = (window as unknown as { __turnChangeCls?: { total: number } }).__turnChangeCls
    if (state) state.total = 0
  })
}

async function readClsProbe(page: Page) {
  return await page.evaluate(
    () => (window as unknown as { __turnChangeCls?: { total: number } }).__turnChangeCls?.total ?? 0,
  )
}

test("turn-change file rows reserve diff height before rendering", async ({ page, llm, project }) => {
  test.setTimeout(180_000)

  await installClsProbe(page)
  const card = await openTurnChangeCard({ page, llm, project })
  const row = card
    .locator('[data-component="session-turn-change-row"]')
    .filter({ hasText: TURN_CHANGE_MODIFIED_DIFF_FILE_PATH })
    .first()
  await expect(row).toBeVisible()

  await resetClsProbe(page)

  for (const _ of [0, 1, 2]) {
    await row.click()
    const diff = card.locator('[data-component="session-turn-change-diff"]').first()
    await expect(diff).toBeVisible()
    await expect
      .poll(async () => await diff.evaluate((el) => Number.parseFloat(getComputedStyle(el).minHeight)), {
        timeout: 10_000,
      })
      .toBeGreaterThanOrEqual(384)
    await expect(diff.locator('[data-component="file"]').first()).toBeVisible({ timeout: 30_000 })
    await row.click()
    await expect(diff).toHaveCount(0)
  }

  expect(await readClsProbe(page)).toBeLessThan(0.1)
})

test("small replacement diffs settle close to rendered content height", async ({ page, llm, project }) => {
  test.setTimeout(180_000)

  await installClsProbe(page)
  const card = await openTurnChangeCard({ page, llm, project })
  const row = card
    .locator('[data-component="session-turn-change-row"]')
    .filter({ hasText: TURN_CHANGE_SMALL_MODIFIED_DIFF_FILE_PATH })
    .first()
  await expect(row).toBeVisible()

  await resetClsProbe(page)
  await row.click()
  const diff = card.locator('[data-component="session-turn-change-diff"]').first()
  await expect(diff).toBeVisible()
  await expect(diff.locator('[data-component="file"]').first()).toBeVisible({ timeout: 30_000 })
  const lines = diff.locator("[data-line]")
  await expect(lines.first()).toBeVisible({ timeout: 30_000 })

  await expect
    .poll(async () => {
      const containerBox = await diff.boundingBox()
      const firstLineBox = await lines.first().boundingBox()
      const lastLineBox = await lines.last().boundingBox()
      if (!containerBox || !firstLineBox || !lastLineBox) return Number.POSITIVE_INFINITY
      const renderedContentHeight = lastLineBox.y + lastLineBox.height - firstLineBox.y
      return containerBox.height - renderedContentHeight
    })
    .toBeLessThan(96)

  expect(await readClsProbe(page)).toBeLessThan(0.1)
})
