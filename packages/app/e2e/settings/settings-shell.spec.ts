import { test, expect } from "../fixtures"
import { closeSettingsPanel, openSettings } from "../actions"

// Foundation lock for the settings route: nav in the sidebar slot, content in the main slot.
test("@smoke settings shell shows the migrated nav and switches pages", async ({ page, gotoSession }) => {
  await gotoSession()

  const settings = await openSettings(page)

  // The nav takes over the sidebar slot rather than painting its own column.
  await expect(page.locator('[data-component="sidebar-nav-desktop"] [data-component="settings-nav"]')).toBeVisible()

  // On open it lands on General (selected + content shown) without needing a manual click.
  await expect(settings.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true")
  await expect(settings.locator('[data-action="settings-language"]')).toBeVisible()

  for (const name of ["General", "Shortcuts", "Models", "Integrations", "Worktrees", "Memory"]) {
    await expect(settings.getByRole("tab", { name })).toBeVisible()
  }
  await expect(settings.getByRole("tab", { name: "Remote access" })).toHaveCount(0)

  // Models page = providers + models stacked: both blocks render
  await settings.getByRole("tab", { name: "Models" }).click()
  await expect(settings.locator('[data-component="custom-provider-section"]')).toBeVisible()
  await expect(settings.getByPlaceholder("Search models")).toBeVisible()

  // Switch to Memory: the models content disappears, proving content follows the nav
  await settings.getByRole("tab", { name: "Memory" }).click()
  await expect(settings.locator('[data-component="custom-provider-section"]')).toHaveCount(0)

  await closeSettingsPanel(page, settings)
})

// openSettings returns shell-content (the slot ancestor), which also hosts the session view and
// never detaches. Assert close on settings-page instead: it is only mounted while settings is open,
// the same signal closeSettingsPanel keys on.
test("@smoke escape closes the settings shell", async ({ page, gotoSession }) => {
  await gotoSession()

  await openSettings(page)
  const settingsPage = page.locator('[data-component="settings-page"]')
  await expect(settingsPage).toBeVisible()

  await page.keyboard.press("Escape")
  await expect(settingsPage).toHaveCount(0)
})

// The Escape capture listener must let an open Kobalte popover (Select dropdown, etc.) consume
// Escape first — otherwise pressing Escape to dismiss a dropdown tears down the whole shell.
test("@smoke escape with an open select closes the dropdown, not the settings shell", async ({ page, gotoSession }) => {
  await gotoSession()

  await openSettings(page)
  const settingsPage = page.locator('[data-component="settings-page"]')
  await expect(settingsPage).toBeVisible()

  await settingsPage.locator('[data-action="settings-language"] [data-slot="select-select-trigger"]').click()
  const dropdown = page.locator('[data-component="select-content"]')
  await expect(dropdown).toBeVisible()

  await page.keyboard.press("Escape")

  // Dropdown dismissed, settings still open.
  await expect(dropdown).toHaveCount(0)
  await expect(settingsPage).toBeVisible()
})

test("@smoke back-to-app button closes the settings shell", async ({ page, gotoSession }) => {
  await gotoSession()

  const settings = await openSettings(page)
  const settingsPage = page.locator('[data-component="settings-page"]')
  await expect(settingsPage).toBeVisible()

  await settings.getByRole("button", { name: "Back to app" }).click()
  await expect(settingsPage).toHaveCount(0)
})
