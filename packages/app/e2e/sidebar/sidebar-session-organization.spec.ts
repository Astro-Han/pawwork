import { test, expect } from "../fixtures"
import { openSidebar } from "../actions"
import { inlineInputSelector, pawworkSidebarSelector } from "../selectors"

test("users can pin, rename, and regroup sessions in the PawWork sidebar", async ({ page, sdk, gotoSession }) => {
  const stamp = Date.now()
  const one = await sdk.session.create({ title: `Ops weekly ${stamp}` }).then((r) => r.data)
  const two = await sdk.session.create({ title: `Board draft ${stamp}` }).then((r) => r.data)

  if (!one?.id || !two?.id) throw new Error("missing session ids")

  await gotoSession(one.id)
  await openSidebar(page)

  const sidebar = page.locator(pawworkSidebarSelector).first()
  const row = sidebar.locator(`[data-session-id="${two.id}"]`).first()

  await row.hover()
  await row.locator('[data-action="session-row-menu"]').click()
  await page.getByRole("menuitem", { name: /pin session/i }).click()
  await expect(sidebar.locator(`[data-component="pawwork-sidebar-pinned"] [data-session-id="${two.id}"]`)).toBeVisible()

  const renameRow = sidebar.locator(`[data-session-id="${one.id}"]`).first()
  await renameRow.hover()
  await renameRow.locator('[data-action="session-row-menu"]').click()
  await page.getByRole("menuitem", { name: /rename/i }).click()
  const input = sidebar.locator(`[data-session-id="${one.id}"] ${inlineInputSelector}`)
  await expect(input).toBeVisible()
  await expect(input).toBeFocused()
  await input.fill(`Ops weekly renamed ${stamp}`)
  await input.press("Enter")
  await expect(sidebar.locator(`[data-session-id="${one.id}"]`)).toContainText(`Ops weekly renamed ${stamp}`)

  await sidebar.locator('[data-action="pawwork-sort-mode"]').click()
  await expect(sidebar.locator('[data-component="pawwork-group-header"]')).toHaveCount(1)
})
