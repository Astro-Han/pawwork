import { test } from "../fixtures"
import { openSidebar, closeSidebar, withSession } from "../actions"
import { pawworkSidebarSelector } from "../selectors"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 1440, height: 900 } })

test("sidebar", async ({ page, sdk, gotoSession }) => {
  test.setTimeout(180_000)

  await withSession(sdk, "snap sidebar a", async (a) => {
    await withSession(sdk, "snap sidebar b", async () => {
      await gotoSession(a.id)
      await openSidebar(page)

      const sidebar = page.locator(pawworkSidebarSelector).first()
      const sortTrigger = sidebar.locator('[data-action="pawwork-sort-trigger"]')
      await sortTrigger.waitFor({ state: "visible" })

      const shots: Shot[] = []

      // Crop to the sidebar locator: web vs Electron differs in chrome (titlebar,
      // traffic lights) but the sidebar's own DOM/CSS renders identically.
      // Element-cropped screenshots stay relevant for component-level review.
      shots.push({ name: "default", buf: await sidebar.screenshot() })

      await sortTrigger.click()
      const sortOption = page.locator('[data-action="pawwork-sort-option"]').first()
      await sortOption.waitFor({ state: "visible" })
      // The sort menu is a portaled popover outside the sidebar DOM — capture the
      // viewport (not the sidebar locator) so the dropdown appears in the shot.
      shots.push({ name: "sort-menu", buf: await page.screenshot({ fullPage: false }) })
      await page.keyboard.press("Escape")

      await closeSidebar(page)
      // After close the sidebar container collapses to ~0 width, so locator screenshot
      // is useless. The toggle button is always present — anchor a clip around its
      // bounding box so we capture the rail wherever it ends up.
      const toggle = page.getByRole("button", { name: /toggle sidebar/i }).first()
      await toggle.waitFor({ state: "visible" })
      const box = await toggle.boundingBox()
      if (!box) throw new Error("snap: toggle button has no bounding box; closed-state shot would be empty")
      const railWidth = Math.max(96, Math.ceil(box.x + box.width + 24))
      shots.push({
        name: "closed",
        buf: await page.screenshot({ clip: { x: 0, y: 0, width: railWidth, height: 900 } }),
      })

      const out = snapOutputPath("sidebar")
      await composeGrid(shots, out)
      process.stdout.write(`\n[snap] sidebar grid -> ${out}\n\n`)
    })
  })
})
