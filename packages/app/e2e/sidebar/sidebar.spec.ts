import { test, expect } from "../fixtures"
import { openSidebar, toggleSidebar, withSession } from "../actions"
import { sidebarNavMobileSelector, titlebarShellSelector } from "../selectors"

test("@smoke sidebar can be collapsed and expanded", async ({ page, gotoSession }) => {
  await gotoSession()

  await openSidebar(page)
  const button = page.getByRole("button", { name: /toggle sidebar/i }).first()
  await expect(button).toHaveAttribute("aria-expanded", "true")

  await toggleSidebar(page)
  await expect(button).toHaveAttribute("aria-expanded", "false")

  await toggleSidebar(page)
  await expect(button).toHaveAttribute("aria-expanded", "true")
})

test("sidebar collapsed state persists across navigation and reload", async ({ page, sdk, gotoSession }) => {
  await withSession(sdk, "sidebar persist session 1", async (session1) => {
    await withSession(sdk, "sidebar persist session 2", async (session2) => {
      await gotoSession(session1.id)

      await openSidebar(page)
      const button = page.getByRole("button", { name: /toggle sidebar/i }).first()
      await toggleSidebar(page)
      await expect(button).toHaveAttribute("aria-expanded", "false")

      await gotoSession(session2.id)
      await expect(button).toHaveAttribute("aria-expanded", "false")

      await page.reload()
      await expect(button).toHaveAttribute("aria-expanded", "false")

      const opened = await page.evaluate(
        () => JSON.parse(localStorage.getItem("pawwork.global.dat:layout") ?? "{}").sidebar?.opened,
      )
      await expect(opened).toBe(false)
    })
  })
})

test("narrow desktop sidebar starts below the shell titlebar", async ({ page, gotoSession }) => {
  await page.setViewportSize({ width: 1180, height: 900 })
  await gotoSession()

  const menuButton = page.getByRole("button", { name: /toggle menu/i }).first()
  await expect(menuButton).toBeVisible()
  await menuButton.click()
  await expect(menuButton).toHaveAttribute("aria-expanded", "true")

  const titlebar = await page.locator(titlebarShellSelector).boundingBox()
  const mobileSidebar = await page.locator(sidebarNavMobileSelector).boundingBox()

  expect(titlebar).not.toBeNull()
  expect(mobileSidebar).not.toBeNull()
  expect(Math.round(mobileSidebar!.y)).toBeGreaterThanOrEqual(Math.round(titlebar!.height) - 1)
})
