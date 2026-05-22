import { expect, type Page } from "@playwright/test"
import { openSidebar, withSession } from "../actions"
import { test } from "../fixtures"
import { pawworkSidebarSelector } from "../selectors"
import { applyDarkModeForTests } from "../utils"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

// Focused crop on the sidebar↔thread column boundary in both themes.
// Preview anchor for human-eye verification, not a regression gate: the
// PNG is written to the snap output dir and the test only asserts the
// buffer is non-empty. Token-level regressions (alpha drift, missing
// border-right token) are caught by `theme-parity`. App-shell snap
// covers the full shell composition; this one zooms in on the 80px
// window straddling the seam so the artifact is readable at a glance.
async function captureBoundary(page: Page, label: "light" | "dark"): Promise<Shot> {
  await openSidebar(page)
  const sidebar = page.locator(pawworkSidebarSelector)
  await sidebar.waitFor({ state: "visible" })
  const box = await sidebar.boundingBox()
  if (!box) throw new Error("snap: sidebar bounding box missing; divider crop would be empty")

  // 80px window straddling the right edge of the sidebar so the divider
  // sits in the middle of the frame against both sidebar fill and main fill.
  // Anchor y/height to the sidebar box so the titlebar above the sidebar
  // doesn't leak into the crop.
  const seamX = Math.round(box.x + box.width)
  const cropX = Math.max(0, seamX - 40)
  const cropW = 80
  const cropY = Math.max(0, Math.round(box.y))
  const cropH = Math.min(640, Math.round(box.height))

  return {
    name: label,
    buf: await page.screenshot({ clip: { x: cropX, y: cropY, width: cropW, height: cropH } }),
  }
}

test("sidebar-divider", async ({ page, sdk, gotoSession }) => {
  test.setTimeout(180_000)

  await withSession(sdk, "snap divider session", async (session) => {
    await gotoSession(session.id)
    const lightShot = await captureBoundary(page, "light")

    await applyDarkModeForTests(page)
    await gotoSession(session.id)
    const darkShot = await captureBoundary(page, "dark")

    expect(lightShot.buf.byteLength).toBeGreaterThan(0)
    expect(darkShot.buf.byteLength).toBeGreaterThan(0)

    const out = snapOutputPath("sidebar-divider")
    await composeGrid([lightShot, darkShot], out)
    process.stdout.write(`\n[snap] sidebar-divider grid -> ${out}\n\n`)
  })
})
