import { test, expect } from "../fixtures"
import { openSettings, openSidebar, withSession } from "../actions"
import { pawworkSidebarSelector } from "../selectors"

test("clicking a sidebar session closes the settings overlay and navigates", async ({
  page,
  sdk,
  gotoSession,
}) => {
  const stamp = Date.now()
  await withSession(sdk, `settings-nav a ${stamp}`, async (a) => {
    await withSession(sdk, `settings-nav b ${stamp}`, async (b) => {
      await gotoSession(a.id)
      await openSidebar(page)

      const settings = await openSettings(page)
      await expect(settings).toBeVisible()

      const sidebar = page.locator(pawworkSidebarSelector).first()
      await sidebar.locator(`[data-session-id="${b.id}"]`).first().click()

      await expect(settings).toBeHidden()
      await expect.poll(() => page.url()).toContain(b.id)
    })
  })
})
