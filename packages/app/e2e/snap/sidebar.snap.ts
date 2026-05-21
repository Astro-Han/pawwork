import type { Page } from "@playwright/test"
import { test } from "../fixtures"
import { openSidebar, closeSidebar, withSession } from "../actions"
import { pawworkSidebarSelector } from "../selectors"
import { applyDarkModeForTests } from "../utils"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 1440, height: 900 } })

async function captureSidebarPass(page: Page, label: "light" | "dark"): Promise<Shot[]> {
  await openSidebar(page)

  const sidebar = page.locator(pawworkSidebarSelector)
  const sortTrigger = sidebar.locator('[data-action="pawwork-sort-trigger"]')
  await sortTrigger.waitFor({ state: "visible" })

  const shots: Shot[] = []
  shots.push({ name: `${label}-default`, buf: await sidebar.screenshot() })

  await sortTrigger.click()
  const sortOption = page.locator('[data-action="pawwork-sort-option"]').first()
  await sortOption.waitFor({ state: "visible" })
  shots.push({ name: `${label}-sort-menu`, buf: await page.screenshot({ fullPage: false }) })
  await page.keyboard.press("Escape")

  await closeSidebar(page)
  const toggle = page.locator('[data-action="pawwork-sidebar-toggle"]')
  await toggle.waitFor({ state: "visible" })
  const box = await toggle.boundingBox()
  if (!box) throw new Error("snap: toggle button has no bounding box; closed-state shot would be empty")
  const railWidth = Math.max(96, Math.ceil(box.x + box.width + 24))
  const viewportH = page.viewportSize()?.height ?? 900
  shots.push({
    name: `${label}-closed`,
    buf: await page.screenshot({ clip: { x: 0, y: 0, width: railWidth, height: viewportH } }),
  })

  return shots
}

test("sidebar", async ({ page, sdk, gotoSession }) => {
  test.setTimeout(240_000)

  // Two sessions so the sidebar list isn't empty; the sort trigger only
  // renders when there is something to sort.
  await withSession(sdk, "snap sidebar a", async (a) => {
    await withSession(sdk, "snap sidebar b", async () => {
      await gotoSession(a.id)
      const lightShots = await captureSidebarPass(page, "light")

      // Flip to dark via the real storage + reload path; sessions stay alive
      // in the backend, so re-navigating to session A restores the same
      // sidebar state for the dark pass.
      await applyDarkModeForTests(page)
      await gotoSession(a.id)
      const darkShots = await captureSidebarPass(page, "dark")

      const out = snapOutputPath("sidebar")
      await composeGrid([...lightShots, ...darkShots], out)
      process.stdout.write(`\n[snap] sidebar grid -> ${out}\n\n`)
    })
  })
})
