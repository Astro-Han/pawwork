import { test, expect } from "../fixtures"
import { closeSettingsPanel, openSettings } from "../actions"

// PR1 foundation lock: shell-slot takeover (nav in the sidebar slot, content in the main slot),
// migrating the existing pages in place (remote / integrations hidden until ready).
test("settings shell shows the migrated nav and switches pages", async ({ page, gotoSession }) => {
  await gotoSession()

  const settings = await openSettings(page)

  // The nav takes over the sidebar slot rather than painting its own column.
  await expect(page.locator('[data-component="sidebar-nav-desktop"] [data-component="settings-nav"]')).toBeVisible()

  // On open it lands on General (selected + content shown) without needing a manual click.
  await expect(settings.getByRole("tab", { name: "General" })).toHaveAttribute("aria-selected", "true")
  await expect(settings.locator('[data-action="settings-language"]')).toBeVisible()

  // Currently 5 tabs: General / Shortcuts / Models / Worktrees / Memory
  for (const name of ["General", "Shortcuts", "Models", "Worktrees", "Memory"]) {
    await expect(settings.getByRole("tab", { name })).toBeVisible()
  }
  // Remote access / Integrations stay hidden until their pages are ready
  await expect(settings.getByRole("tab", { name: "Remote access" })).toHaveCount(0)
  await expect(settings.getByRole("tab", { name: "Integrations" })).toHaveCount(0)

  // Models page = providers + models stacked: both blocks render
  await settings.getByRole("tab", { name: "Models" }).click()
  await expect(settings.locator('[data-component="custom-provider-section"]')).toBeVisible()
  await expect(settings.getByPlaceholder("Search models")).toBeVisible()

  // Switch to Memory: the models content disappears, proving content follows the nav
  await settings.getByRole("tab", { name: "Memory" }).click()
  await expect(settings.locator('[data-component="custom-provider-section"]')).toHaveCount(0)

  await closeSettingsPanel(page, settings)
})

test("escape closes the settings shell", async ({ page, gotoSession }) => {
  await gotoSession()

  const settings = await openSettings(page)
  await expect(settings).toBeVisible()

  await page.keyboard.press("Escape")
  await expect(settings).toBeHidden()
})

test("back-to-app button closes the settings shell", async ({ page, gotoSession }) => {
  await gotoSession()

  const settings = await openSettings(page)
  await expect(settings).toBeVisible()

  await settings.getByRole("button", { name: "Back to app" }).click()
  await expect(settings).toBeHidden()
})
