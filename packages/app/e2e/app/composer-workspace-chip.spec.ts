import { expect, test } from "../fixtures"
import { withSession } from "../actions"

test("workspace chip popover opens on click", async ({ page, project }) => {
  await project.open()
  const chip = page.locator('[data-action="prompt-workspace"]')
  await chip.click()

  const popover = page.getByRole("menu")
  await expect(popover).toBeVisible()

  const firstItem = popover.getByRole("menuitemradio").first()
  await expect(firstItem).toBeVisible()
})

test("active workspace has a check icon", async ({ page, project }) => {
  await project.open()
  const chip = page.locator('[data-action="prompt-workspace"]')
  await chip.click()

  const popover = page.getByRole("menu")
  const active = popover.locator("button").filter({ has: page.locator('[data-icon="check"]') })
  await expect(active).toHaveCount(1)
})

test("workspace chip hidden in session", async ({ page, sdk, gotoSession }) => {
  await withSession(sdk, `e2e ws-chip hidden ${Date.now()}`, async (session) => {
    await gotoSession(session.id)
    await expect(page.locator('[data-action="prompt-workspace"]')).toHaveCount(0)
  })
})

test("outside click and Esc dismiss popover", async ({ page, project }) => {
  await project.open()
  const chip = page.locator('[data-action="prompt-workspace"]')
  await chip.click()
  await expect(page.getByRole("menu")).toBeVisible()

  await page.keyboard.press("Escape")
  await expect(page.getByRole("menu")).toHaveCount(0)

  await chip.click()
  // deterministic outside-click target: the home hero heading region
  await page.locator('[data-component="session-new-home"]').getByRole("heading").first().click()
  await expect(page.getByRole("menu")).toHaveCount(0)
})
