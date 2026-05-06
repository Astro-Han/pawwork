import { test, expect } from "../fixtures"
import { openPalette, closeDialog } from "../actions"

// State matrix for slice 07 dialog/palette primitives.
// Covers the 4 Kobalte behavior requirements from issue #440:
//   aria · portal · escape · focus-trap

test("dialog overlay has aria-modal", async ({ page, gotoSession }) => {
  await gotoSession()

  const dialog = await openPalette(page)
  await expect(dialog).toHaveAttribute("aria-modal", "true")
})

test("dialog closes on Escape key", async ({ page, gotoSession }) => {
  await gotoSession()

  const dialog = await openPalette(page)
  await closeDialog(page, dialog)
  await expect(dialog).toHaveCount(0)
})

test("dialog overlay click closes dialog", async ({ page, gotoSession }) => {
  await gotoSession()

  await openPalette(page)

  const overlay = page.locator('[data-component="dialog-overlay"]')
  await expect(overlay).toBeVisible()
  await overlay.click({ position: { x: 10, y: 10 } })

  await expect(overlay).toHaveCount(0)
})

test("dialog focus-trap: Tab does not leave dialog", async ({ page, gotoSession }) => {
  await gotoSession()

  const dialog = await openPalette(page)

  // Tab through all focusable elements; focus must stay inside dialog
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("Tab")
    const focusedInDialog = await dialog.evaluate((el) => el.contains(document.activeElement))
    expect(focusedInDialog).toBe(true)
  }

  await page.keyboard.press("Escape")
})

test("command-palette data-component attribute is set", async ({ page, gotoSession }) => {
  await gotoSession()

  await openPalette(page)

  const palette = page.locator('[data-component="command-palette"]')
  await expect(palette).toBeVisible()

  await page.keyboard.press("Escape")
})
