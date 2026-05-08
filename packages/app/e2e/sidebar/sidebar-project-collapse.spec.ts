import { test, expect } from "../fixtures"
import { openSidebar, withSession } from "../actions"
import { pawworkSidebarSelector } from "../selectors"

test("project group folds and unfolds", async ({ page, sdk, gotoSession }) => {
  const stamp = Date.now()
  await withSession(sdk, `collapse a ${stamp}`, async (a) => {
    await withSession(sdk, `collapse b ${stamp}`, async () => {
      await gotoSession(a.id)
      await openSidebar(page)

      const sidebar = page.locator(pawworkSidebarSelector).first()

      // Switch to project sort so group headers exist.
      await sidebar.locator('[data-action="pawwork-sort-trigger"]').click()
      await page.locator('[data-action="pawwork-sort-option"][data-value="project"]').click()

      const header = sidebar.locator('[data-action="pawwork-group-toggle"]').first()
      const content = sidebar.locator('[data-component="pawwork-group-content"]').first()
      await expect(header).toBeVisible()
      await expect(header).toHaveAttribute("aria-expanded", "true")
      await expect(content).not.toHaveAttribute("data-collapsed", "true")

      await header.click()
      await expect(header).toHaveAttribute("aria-expanded", "false")
      await expect(header).toHaveAttribute("data-collapsed", "true")
      // Items stay mounted (focus / scroll preserved); the wrapper is the hide signal.
      await expect(content).toHaveAttribute("data-collapsed", "true")
      await expect(content).toHaveAttribute("aria-hidden", "true")
      // Visible height collapses to 0 via grid-template-rows: 0fr.
      await expect.poll(async () => (await content.boundingBox())?.height ?? -1).toBeLessThan(2)

      await header.click()
      await expect(header).toHaveAttribute("aria-expanded", "true")
      await expect(content).not.toHaveAttribute("data-collapsed", "true")
      await expect.poll(async () => (await content.boundingBox())?.height ?? 0).toBeGreaterThan(0)
    })
  })
})

test("project collapsed state persists across reload", async ({ page, sdk, gotoSession }) => {
  const stamp = Date.now()
  await withSession(sdk, `persist collapse ${stamp}`, async (s) => {
    await gotoSession(s.id)
    await openSidebar(page)

    const sidebar = page.locator(pawworkSidebarSelector).first()
    await sidebar.locator('[data-action="pawwork-sort-trigger"]').click()
    await page.locator('[data-action="pawwork-sort-option"][data-value="project"]').click()

    const header = sidebar.locator('[data-action="pawwork-group-toggle"]').first()
    await header.click()
    await expect(header).toHaveAttribute("data-collapsed", "true")

    await page.reload()
    await openSidebar(page)
    const reloaded = page
      .locator(pawworkSidebarSelector)
      .first()
      .locator('[data-action="pawwork-group-toggle"]')
      .first()
    await expect(reloaded).toBeVisible()
    await expect(reloaded).toHaveAttribute("data-collapsed", "true")
    await expect(reloaded).toHaveAttribute("aria-expanded", "false")
  })
})
