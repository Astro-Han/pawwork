import { expect, type Page } from "@playwright/test"
import { openSidebar, withSession } from "../actions"
import { test } from "../fixtures"
import { pawworkSidebarSelector } from "../selectors"
import { applyDarkModeForTests } from "../utils"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

// Focused crop on the sidebar↔thread column boundary in both themes.
// app-shell already covers the full shell composition; this target zooms
// in on the 1px hairline so the regression signal is "did the divider go
// missing / wrong-alpha" rather than getting lost in a 1440x900 thumbnail.
async function captureBoundary(page: Page, label: "light" | "dark"): Promise<Shot> {
  await openSidebar(page)
  const sidebar = page.locator(pawworkSidebarSelector)
  await sidebar.waitFor({ state: "visible" })
  const box = await sidebar.boundingBox()
  if (!box) throw new Error("snap: sidebar bounding box missing; divider crop would be empty")

  // 80px window straddling the right edge of the sidebar so the divider
  // sits in the middle of the frame against both sidebar fill and main fill.
  const seamX = Math.round(box.x + box.width)
  const cropX = Math.max(0, seamX - 40)
  const cropW = 80
  const cropH = Math.min(640, page.viewportSize()?.height ?? 900)

  return {
    name: label,
    buf: await page.screenshot({ clip: { x: cropX, y: 0, width: cropW, height: cropH } }),
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
