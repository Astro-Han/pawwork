import type { Locator, Page } from "@playwright/test"
import { test, expect } from "../fixtures"
import { openPalette } from "../actions"
import { applyDarkModeForTests } from "../utils"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

// Visual contract for the command palette's grouped section headers:
//
//   In dark mode --surface-base (#1a1917) is noticeably darker than the
//   palette body's --surface-raised (#2d2a27). The List component paints its
//   sticky group header on its own surface, exposed as the inherited
//   --list-surface custom property (default --surface-base). The palette sits
//   on --surface-raised, so palette-content must set --list-surface to match;
//   otherwise the "Suggested / Navigation / Panels" headers read as black
//   bands across an otherwise warm-grey palette.
//
//   This is the regression guard for that custom-property contract — earlier
//   the palette tried to win the same effect with a low-specificity
//   background override that lost to list.css's 0,4,0 chain (and to its later
//   import order), so the band stayed black in dark mode.
//
// Light + dark are both captured because the bug only appears in dark.
test.use({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 2 })

async function assertHeaderMatchesPaletteSurface(page: Page) {
  const header = page.locator('[data-component="command-palette"] [data-slot="list-header"]').first()
  await expect(header).toBeVisible()

  // Header surface must match the palette body's --surface-raised, not List's
  // default --surface-base. In dark mode the two differ, so a regression of
  // the --list-surface contract fails here. Poll to absorb first-paint races
  // on a cold dev server, where styles can settle a frame after the header
  // becomes visible.
  await expect
    .poll(() =>
      header.evaluate((el) => {
        const raised = window
          .getComputedStyle(document.documentElement)
          .getPropertyValue("--surface-raised")
          .trim()
        const probe = document.createElement("span")
        probe.style.color = raised
        document.body.appendChild(probe)
        const expectedRgb = window.getComputedStyle(probe).color
        probe.remove()
        const headerBg = window.getComputedStyle(el).backgroundColor
        return headerBg === expectedRgb
      }),
    )
    .toBe(true)
}

test("command-palette-header", async ({ page, gotoSession }) => {
  test.setTimeout(180_000)

  await gotoSession()
  const lightDialog = await openPalette(page)
  await assertHeaderMatchesPaletteSurface(page)
  const lightShot: Shot = { name: "light", buf: await (lightDialog as Locator).screenshot() }
  await page.keyboard.press("Escape")

  await applyDarkModeForTests(page)
  await gotoSession()
  const darkDialog = await openPalette(page)
  await assertHeaderMatchesPaletteSurface(page)
  const darkShot: Shot = { name: "dark", buf: await (darkDialog as Locator).screenshot() }

  const out = snapOutputPath("command-palette-header")
  await composeGrid([lightShot, darkShot], out, { cols: 2 })
  process.stdout.write(`\n[snap] command-palette-header grid -> ${out}\n\n`)
})
