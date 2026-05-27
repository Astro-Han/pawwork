import type { Locator, Page } from "@playwright/test"
import { test, expect } from "../fixtures"
import { openSettings } from "../actions"
import { applyDarkModeForTests } from "../utils"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

// Visual contract for grouped Lists rendered inside a Dialog (the twin of the
// command-palette case). The provider picker dialog groups providers into
// "Popular" / "Other", so each group paints a sticky List header.
//
//   In dark mode --surface-base (#1a1917) is darker than the dialog body's
//   --surface-raised (#2d2a27). The List paints its header on the inherited
//   --list-surface custom property (default --surface-base), so dialog-content
//   must set --list-surface to its own raised surface; otherwise the group
//   labels read as black bands across the warm-grey dialog.
//
//   The shared list.css mechanism is already guarded by
//   command-palette-header.snap.ts; this is the dialog-local guard, so deleting
//   the one --list-surface line from dialog.css fails here rather than slipping
//   through to a dark-mode regression.
//
// Light + dark are both captured because the bug only appears in dark.
test.use({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 2 })

async function openProviderDialog(page: Page): Promise<Locator> {
  const settings = await openSettings(page)
  await settings.getByRole("tab", { name: "Providers" }).click()
  await settings.getByRole("button", { name: "Show more providers" }).click()

  const dialog = page.locator('[data-component="dialog"] [data-slot="dialog-content"]').first()
  await expect(dialog).toBeVisible()
  // The grouped headers are the subject under test; wait for at least one.
  await expect(page.locator('[data-component="dialog"] [data-slot="list-header"]').first()).toBeVisible()
  return dialog
}

async function assertHeaderMatchesDialogSurface(page: Page) {
  const header = page.locator('[data-component="dialog"] [data-slot="list-header"]').first()
  await expect(header).toBeVisible()

  // Header surface must match the dialog body's --surface-raised, not List's
  // default --surface-base. In dark mode the two differ, so a regression of
  // the --list-surface contract fails here. Poll to absorb first-paint races
  // on a cold dev server, where styles can settle a frame after the header
  // becomes visible.
  await expect
    .poll(() =>
      header.evaluate((el) => {
        // Let the browser resolve the token in context instead of copying its
        // raw value off documentElement.
        const probe = document.createElement("span")
        probe.style.color = "var(--surface-raised)"
        document.body.appendChild(probe)
        const expectedRgb = window.getComputedStyle(probe).color
        probe.remove()
        const headerBg = window.getComputedStyle(el).backgroundColor
        return headerBg === expectedRgb
      }),
    )
    .toBe(true)
}

test("dialog-grouped-header", async ({ page, gotoSession }) => {
  test.setTimeout(180_000)

  await gotoSession()
  const lightDialog = await openProviderDialog(page)
  await assertHeaderMatchesDialogSurface(page)
  const lightShot: Shot = { name: "light", buf: await lightDialog.screenshot() }

  await applyDarkModeForTests(page)
  await gotoSession()
  const darkDialog = await openProviderDialog(page)
  await assertHeaderMatchesDialogSurface(page)
  const darkShot: Shot = { name: "dark", buf: await darkDialog.screenshot() }

  const out = snapOutputPath("dialog-grouped-header")
  await composeGrid([lightShot, darkShot], out, { cols: 2 })
  process.stdout.write(`\n[snap] dialog-grouped-header grid -> ${out}\n\n`)
})
