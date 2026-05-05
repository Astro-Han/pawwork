/**
 * text-field-ghost-inline-rename.spec.ts @smoke
 *
 * Golden-path: sidebar rename flow uses TextField ghost variant after InlineInput removal.
 * Verifies the ghost variant renders, focuses, accepts input, and saves on Enter.
 */
import { cleanupSession, openSidebar } from "../actions"
import { test, expect } from "../fixtures"
import { inlineInputSelector, pawworkSidebarSelector } from "../selectors"

test("sidebar rename uses ghost TextField and saves on Enter @smoke", async ({ page, sdk }) => {
  const stamp = Date.now()
  const session = await sdk.session.create({ title: `Ghost rename test ${stamp}` }).then((r) => r.data)
  if (!session?.id) throw new Error("Session create did not return an id")

  try {
    await page.goto(`/`)
    await openSidebar(page)

    const sidebar = page.locator(pawworkSidebarSelector).first()
    const row = sidebar.locator(`[data-session-id="${session.id}"]`).first()

    await row.hover()
    await row.locator('[data-action="session-row-menu"]').click()
    await page.getByRole("menuitem", { name: /rename/i }).click()

    const input = sidebar.locator(`[data-session-id="${session.id}"] ${inlineInputSelector}`)
    await expect(input).toBeVisible()
    await expect(input).toBeFocused()

    const newTitle = `Renamed ghost ${stamp}`
    await input.fill(newTitle)
    await input.press("Enter")

    await expect(sidebar.locator(`[data-session-id="${session.id}"]`)).toContainText(newTitle)
  } finally {
    await cleanupSession({ sdk, sessionID: session.id })
  }
})
