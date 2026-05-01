import { test, expect } from "../fixtures"
import { closeDialog, closeSettingsPanel, openPalette, openSettings, withSession } from "../actions"
import {
  desktopShellFrameSelector,
  desktopShellMainSelector,
  desktopShellSelector,
  titlebarLeftSelector,
  titlebarRightSelector,
  titlebarShellSelector,
} from "../selectors"

test("@smoke shell frame exposes stable desktop hooks", async ({ page, gotoSession }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoSession()

  await expect(page.locator(desktopShellSelector)).toBeVisible()
  await expect(page.locator(desktopShellFrameSelector)).toBeVisible()
  await expect(page.locator(titlebarShellSelector)).toBeVisible()
  await expect(page.locator(desktopShellMainSelector)).toBeVisible()
  await expect(page.locator(titlebarLeftSelector)).toHaveCount(1)
  await expect(page.locator(titlebarLeftSelector)).toContainText(/new session/i)
  await expect(page.locator(`${titlebarRightSelector} button`).first()).toBeVisible()
  await expect(page.getByRole("button", { name: /toggle sidebar/i }).first()).toBeVisible()

  const settings = await openSettings(page)
  await expect(settings.getByRole("heading", { level: 2 })).toBeVisible()
  await closeSettingsPanel(page, settings)

  const palette = await openPalette(page)
  await closeDialog(page, palette)
})

test("home titlebar left slot shows the current view title instead of the old file search affordance", async ({
  page,
  gotoSession,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoSession()

  const left = page.locator(titlebarLeftSelector)
  await expect(left.getByText(/^new session$/i)).toBeVisible()
  await expect(left.getByRole("button", { name: /search files/i })).toHaveCount(0)
})

test("session titlebar left slot shows a project and session breadcrumb", async ({ page, sdk, gotoSession }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const title = `e2e breadcrumb ${Date.now()}`

  await withSession(sdk, title, async (session) => {
    await gotoSession(session.id)

    const left = page.locator(titlebarLeftSelector)
    const buttons = left.getByRole("button")

    await expect(buttons).toHaveCount(1)
    await expect(buttons.first()).toContainText(/.+/)
    await expect(left).toContainText(title)
    await expect(left.getByRole("button", { name: /search files/i })).toHaveCount(0)
  })
})
