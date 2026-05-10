import { test, expect } from "../fixtures"
import { openSidebar, withSession } from "../actions"
import { pawworkSidebarSelector } from "../selectors"

test("project group can be renamed from sidebar", async ({ page, sdk, gotoSession }) => {
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

      // Open the project menu via overflow button
      const menuTrigger = sidebar.locator('[data-action="project-row-menu"]').first()
      await expect(menuTrigger).toBeVisible()
      await menuTrigger.click()

      // Click rename
      const renameItem = page.locator('[data-component="dropdown-menu-content"] .dropdown-menu-item').filter({ hasText: /Rename/ }).first()
      await renameItem.click()

      // Dialog should appear
      const dialog = page.locator('[data-component="dialog"]').filter({ hasText: /Rename/ }).first()
      await expect(dialog).toBeVisible()

      // Type new name
      const input = dialog.locator('input').first()
      await input.fill(`Renamed Project ${stamp}`)

      // Save
      const saveButton = dialog.locator('button').filter({ hasText: /Save/ }).first()
      await saveButton.click()

      // Dialog should close
      await expect(dialog).not.toBeVisible()

      // Header should show new name
      await expect(header).toContainText(`Renamed Project ${stamp}`)
    })
  })
})

test("project group can be removed from sidebar", async ({ page, sdk, gotoSession }) => {
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

      // Click remove
      const removeItem = page.locator('[data-component="dropdown-menu-content"] .dropdown-menu-item').filter({ hasText: /Remove/ }).first()
      await removeItem.click()

      // Confirm dialog should appear
      const dialog = page.locator('[data-component="dialog"]').filter({ hasText: /Remove/ }).first()
      await expect(dialog).toBeVisible()

      // Confirm removal
      const confirmButton = dialog.locator('button').filter({ hasText: /Remove/ }).first()
      await confirmButton.click()

      // Dialog should close
      await expect(dialog).not.toBeVisible()

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

    const removeItem = page.locator('[data-component="dropdown-menu-content"] .dropdown-menu-item').filter({ hasText: /Remove/ }).first()
    await removeItem.click()

    const dialog = page.locator('[data-component="dialog"]').filter({ hasText: /Remove/ }).first()
    await expect(dialog).toBeVisible()
    await dialog.locator('button').filter({ hasText: /Remove/ }).first().click()

    // Group should be hidden
    const groups = sidebar.locator('[data-action="pawwork-group-toggle"]')
    const countAfterRemove = await groups.count()

    // Now open the session again (this should restore the project)
    await gotoSession(a.id)
    await openSidebar(page)

    // Switch to project sort again
    await sidebar.locator('[data-action="pawwork-sort-trigger"]').click()
    await page.locator('[data-action="pawwork-sort-option"][data-value="project"]').click()

    // Group should be back
    await expect.poll(async () => await groups.count()).toBeGreaterThan(countAfterRemove)
  })
})
