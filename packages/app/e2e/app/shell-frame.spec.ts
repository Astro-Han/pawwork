import { test, expect } from "../fixtures"
import { closeDialog, openPalette, openSettings } from "../actions"
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
  await expect(page.locator(`${titlebarCenterSelector} button`).first()).toBeVisible()
  await expect(page.locator(`${titlebarRightSelector} button`).first()).toBeVisible()
  await expect(page.getByRole("button", { name: /toggle sidebar/i }).first()).toBeVisible()
  await expect(page.getByRole("button", { name: /navigate back/i })).toBeVisible()
  await expect(page.getByRole("button", { name: /navigate forward/i })).toBeVisible()

  const settings = await openSettings(page)
  await expect(settings.getByRole("heading", { level: 2 })).toBeVisible()
  await closeDialog(page, settings)

  const palette = await openPalette(page)
  await closeDialog(page, palette)
})

test("session titlebar center keeps a project-directory affordance next to file search", async ({ page, gotoSession }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await gotoSession()

  const center = page.locator(titlebarCenterSelector)
  const buttons = center.getByRole("button")
  const openProject = buttons.first()
  const searchFiles = center.getByRole("button", { name: /search files/i })

  await expect(buttons).toHaveCount(2)
  await expect(openProject).toBeVisible()
  await expect(openProject).toHaveAttribute("title", /.+/)
  await expect(openProject).toContainText(/.+/)
  await expect(searchFiles).toBeVisible()
})
