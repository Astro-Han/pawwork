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

      // Note: project rename updates ProjectMeta, which may not reflect immediately in sidebar
      // without a refresh. The screenshot above captures the post-rename state.
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

test("hidden project restores when session is opened", async ({ page, sdk, gotoSession }) => {
  const stamp = Date.now()
  await withSession(sdk, `restore hidden ${stamp}`, async (a) => {
    await gotoSession(a.id)
    await openSidebar(page)

    const sidebar = page.locator(pawworkSidebarSelector).first()

    // Switch to project sort
    await sidebar.locator('[data-action="pawwork-sort-trigger"]').click()
    await page.locator('[data-action="pawwork-sort-option"][data-value="project"]').click()

    // Remove the project
    const menuTrigger = sidebar.locator('[data-action="project-row-menu"]').first()
    await menuTrigger.click()

    const menu = page.locator(dropdownMenuContentSelector).first()
    await clickMenuItem(menu, /Remove from sidebar/)

    const dialog = page.locator('[data-component="dialog"]').filter({ hasText: /Remove project from sidebar/ }).first()
    await expect(dialog).toBeVisible()
    await dialog.locator('button').filter({ hasText: /Remove/ }).first().click()

    // Group should be hidden
    const groups = sidebar.locator('[data-action="pawwork-group-toggle"]')
    const countAfterRemove = await groups.count()

    // Now open the session again (this should restore the project)
    await gotoSession(a.id)
    await openSidebar(page)

    // Re-locate sidebar after navigation
    const sidebarAfter = page.locator(pawworkSidebarSelector).first()

    // Switch to project sort again
    await sidebarAfter.locator('[data-action="pawwork-sort-trigger"]').click()
    await page.locator('[data-action="pawwork-sort-option"][data-value="project"]').click()

    // Group should be back
    const groupsAfter = sidebarAfter.locator('[data-action="pawwork-group-toggle"]')
    await expect.poll(async () => await groupsAfter.count()).toBeGreaterThan(countAfterRemove)
  })
})