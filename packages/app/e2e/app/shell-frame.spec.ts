import { test, expect } from "../fixtures"
import { closeDialog, closeSettingsPanel, openPalette, openSettings, withSession } from "../actions"
import {
  desktopShellFrameSelector,
  desktopShellMainSelector,
  desktopShellSelector,
  titlebarCenterSelector,
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
  await expect(page.locator(titlebarCenterSelector)).toContainText(/new session/i)
  await expect(page.locator(`${titlebarRightSelector} button`).first()).toBeVisible()
  await expect(page.getByRole("button", { name: /toggle sidebar/i }).first()).toBeVisible()

  const settings = await openSettings(page)
  await expect(settings.getByRole("heading", { level: 2 })).toBeVisible()
  await closeSettingsPanel(page, settings)

  const palette = await openPalette(page)
  await closeDialog(page, palette)
})

test("home titlebar center shows the current view title instead of the old file search affordance", async ({
  page,
  gotoSession,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoSession()

  const center = page.locator(titlebarCenterSelector)
  await expect(center.getByText(/^new session$/i)).toBeVisible()
  await expect(center.getByRole("button", { name: /search files/i })).toHaveCount(0)
})

test("session titlebar center shows a project and session breadcrumb", async ({ page, sdk, gotoSession }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const title = `e2e breadcrumb ${Date.now()}`

  await withSession(sdk, title, async (session) => {
    await gotoSession(session.id)

    const center = page.locator(titlebarCenterSelector)
    const buttons = center.getByRole("button")

    await expect(buttons).toHaveCount(1)
    await expect(buttons.first()).toContainText(/.+/)
    await expect(center).toContainText(title)
    await expect(center).toContainText("/")
    await expect(center.getByRole("button", { name: /search files/i })).toHaveCount(0)
  })
})
