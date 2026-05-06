/**
 * session-rename-dialog.spec.ts @smoke
 *
 * Golden-path: sidebar rename opens a Dialog with a TextField, saves on Enter,
 * and the new title shows up in the sidebar row.
 */
import { cleanupSession, openSidebar } from "../actions"
import { test, expect } from "../fixtures"
import { pawworkSidebarSelector } from "../selectors"

test("sidebar rename uses Dialog and saves on Enter @smoke", async ({ page, sdk, gotoSession }) => {
  const stamp = Date.now()
  const session = await sdk.session.create({ title: `Rename dialog test ${stamp}` }).then((r) => r.data)
  if (!session?.id) throw new Error("Session create did not return an id")

  try {
    await gotoSession(session.id)
    await openSidebar(page)

    const sidebar = page.locator(pawworkSidebarSelector).first()
    const row = sidebar.locator(`[data-session-id="${session.id}"]`).first()

    await row.hover()
    await row.locator('[data-action="session-row-menu"]').click()
    await page.getByRole("menuitem", { name: /rename/i }).click()

    const dialog = page.locator('[data-component="dialog"]')
    await expect(dialog).toBeVisible()

    const input = dialog.getByRole("textbox")
    await expect(input).toBeVisible()
    await expect(input).toBeFocused()

    const newTitle = `Renamed dialog ${stamp}`
    await input.fill(newTitle)
    await input.press("Enter")

    await expect(dialog).toBeHidden()
    await expect(sidebar.locator(`[data-session-id="${session.id}"]`)).toContainText(newTitle)
  } finally {
    await cleanupSession({ sdk, sessionID: session.id })
  }
})
