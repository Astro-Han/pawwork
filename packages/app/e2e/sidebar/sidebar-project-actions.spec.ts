import { test, expect } from "../fixtures"
import { openSidebar, withSession, clickMenuItem } from "../actions"
import { pawworkSidebarSelector, dropdownMenuContentSelector } from "../selectors"
import type { TestInfo } from "@playwright/test"

async function capture(page: any, testInfo: TestInfo, name: string) {
  await page.screenshot({
    path: testInfo.outputPath(`${name}.png`),
    fullPage: true,
  })
}

test("project group can be renamed from sidebar", async ({ page, sdk, gotoSession }, testInfo) => {
  const stamp = Date.now()
  await withSession(sdk, `rename project ${stamp}`, async (a) => {
    await withSession(sdk, `rename project b ${stamp}`, async () => {
      await gotoSession(a.id)
      await openSidebar(page)

      const sidebar = page.locator(pawworkSidebarSelector).first()

      // Switch to project sort so group headers exist.
      await sidebar.locator('[data-action="pawwork-sort-trigger"]').click()
      await page.locator('[data-action="pawwork-sort-option"][data-value="project"]').click()

      const header = sidebar.locator('[data-action="pawwork-group-toggle"]').first()
      await expect(header).toBeVisible()

      // Screenshot: project group header with overflow button
      await capture(page, testInfo, `01-project-header-${stamp}`)

      // Open the project menu via overflow button
      const menuTrigger = sidebar.locator('[data-action="project-row-menu"]').first()
      await expect(menuTrigger).toBeVisible()
      await menuTrigger.click()

      // Screenshot: project menu opened
      await capture(page, testInfo, `02-project-menu-${stamp}`)

      // Click rename
      const menu = page.locator(dropdownMenuContentSelector).first()
      await clickMenuItem(menu, /Rename project/)

      // Dialog should appear
      const dialog = page.locator('[data-component="dialog"]').filter({ hasText: /Rename project/ }).first()
      await expect(dialog).toBeVisible()

      // Screenshot: rename dialog
      await capture(page, testInfo, `03-rename-dialog-${stamp}`)

      // Type new name
      const input = dialog.locator('input').first()
      await input.fill(`Renamed Project ${stamp}`)

      // Save
      const saveButton = dialog.locator('button').filter({ hasText: /Save/ }).first()
      await saveButton.click()

      // Dialog should close
      await expect(dialog).not.toBeVisible()

      // Screenshot: after rename
      await capture(page, testInfo, `04-after-rename-${stamp}`)

      // Header should show new name (with retry since ProjectMeta update is async)
      await expect.poll(async () => await header.textContent()).toContain(`Renamed Project ${stamp}`)
    })
  })
})

test("project group can be removed from sidebar", async ({ page, sdk, gotoSession }, testInfo) => {
  const stamp = Date.now()
  await withSession(sdk, `remove project ${stamp}`, async (a) => {
    await withSession(sdk, `remove project b ${stamp}`, async () => {
      await gotoSession(a.id)
      await openSidebar(page)

      const sidebar = page.locator(pawworkSidebarSelector).first()

      // Switch to project sort so group headers exist.
      await sidebar.locator('[data-action="pawwork-sort-trigger"]').click()
      await page.locator('[data-action="pawwork-sort-option"][data-value="project"]').click()

      // Count initial groups
      const initialGroups = sidebar.locator('[data-action="pawwork-group-toggle"]')
      const initialCount = await initialGroups.count()
      expect(initialCount).toBeGreaterThan(0)

      // Open the project menu via overflow button
      const menuTrigger = sidebar.locator('[data-action="project-row-menu"]').first()
      await expect(menuTrigger).toBeVisible()
      await menuTrigger.click()

      // Screenshot: remove menu
      await capture(page, testInfo, `05-remove-menu-${stamp}`)

      // Click remove
      const menu = page.locator(dropdownMenuContentSelector).first()
      await clickMenuItem(menu, /Remove from sidebar/)

      // Confirm dialog should appear
      const dialog = page.locator('[data-component="dialog"]').filter({ hasText: /Remove project from sidebar/ }).first()
      await expect(dialog).toBeVisible()

      // Screenshot: remove confirm dialog
      await capture(page, testInfo, `06-remove-dialog-${stamp}`)

      // Confirm removal
      const confirmButton = dialog.locator('button').filter({ hasText: /Remove/ }).first()
      await confirmButton.click()

      // Dialog should close
      await expect(dialog).not.toBeVisible()

      // Screenshot: after remove (toast may appear)
      await capture(page, testInfo, `07-after-remove-${stamp}`)

      // Group count should decrease
      const remainingGroups = sidebar.locator('[data-action="pawwork-group-toggle"]')
      await expect.poll(async () => await remainingGroups.count()).toBeLessThan(initialCount)
    })
  })
})

test("hidden project restores on direct navigation", async ({ page, sdk, gotoSession }) => {
  const stamp = Date.now()
  await withSession(sdk, `restore nav ${stamp}`, async (a) => {
    await withSession(sdk, `restore nav b ${stamp}`, async () => {
      await gotoSession(a.id)
      await openSidebar(page)

      const sidebar = page.locator(pawworkSidebarSelector).first()

      // Switch to project sort
      await sidebar.locator('[data-action="pawwork-sort-trigger"]').click()
      await page.locator('[data-action="pawwork-sort-option"][data-value="project"]').click()

      // Count initial groups
      const groups = sidebar.locator('[data-action="pawwork-group-toggle"]')
      const initialCount = await groups.count()
      expect(initialCount).toBeGreaterThan(0)

      // Remove the project
      const menuTrigger = sidebar.locator('[data-action="project-row-menu"]').first()
      await menuTrigger.click()

      const menu = page.locator(dropdownMenuContentSelector).first()
      await clickMenuItem(menu, /Remove from sidebar/)

      const dialog = page.locator('[data-component="dialog"]').filter({ hasText: /Remove project from sidebar/ }).first()
      await expect(dialog).toBeVisible()
      await dialog.locator('button').filter({ hasText: /Remove/ }).first().click()

      // Group should be hidden
      const countAfterRemove = await groups.count()
      expect(countAfterRemove).toBeLessThan(initialCount)

      // Navigate directly to session via URL (triggers syncSessionRoute → unhideProject)
      await gotoSession(a.id)

      // Wait for sidebar to load content
      await expect(sidebar.locator('[data-session-id]')).not.toHaveCount(0, { timeout: 5000 })
      await openSidebar(page)

      // Switch to project sort again
      await sidebar.locator('[data-action="pawwork-sort-trigger"]').click()
      await page.locator('[data-action="pawwork-sort-option"][data-value="project"]').click()

      // Group should be back
      const groupsAfter = sidebar.locator('[data-action="pawwork-group-toggle"]')
      await expect.poll(async () => await groupsAfter.count()).toBeGreaterThan(countAfterRemove)
    })
  })
})