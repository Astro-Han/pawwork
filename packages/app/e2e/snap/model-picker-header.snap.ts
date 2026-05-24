import type { Page } from "@playwright/test"
import { test, expect } from "../fixtures"
import { promptModelSelector } from "../selectors"
import { applyDarkModeForTests } from "../utils"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

// Visual contract for the model picker's grouped list header:
//
//   1) Header background must match the picker surface, not the page surface.
//      In dark mode --surface-base (#1a1917) is noticeably darker than the
//      picker body's --surface-raised (#2d2a27); a header on --surface-base
//      reads as a misaligned band across the popover top.
//   2) The list header must NOT sit sticky inside the picker. List's default
//      sticky behaviour ships a 16px ::after gradient that paints on top of
//      the first item; picker.css overrides position to static and hides the
//      gradient. Both overrides have to outrank list.css's 0,4,0 selector
//      chain, so this snap is the regression check for selector strength.
//
// Light + dark are both captured because bug (1) only appears in dark.
test.use({ viewport: { width: 1100, height: 600 }, deviceScaleFactor: 2 })

const pickerContentSelector = '[data-picker-content=""]'

async function openModelPicker(page: Page) {
  const chip = page.locator(promptModelSelector).locator('[data-action="prompt-model"]').first()
  await expect(chip).toBeVisible({ timeout: 30_000 })
  await chip.click()
  // Variant (Thinking) sub-popover also uses [data-picker-content]; scope by
  // the model list scroll container so the locator stays unambiguous.
  const picker = page
    .locator(pickerContentSelector)
    .filter({ has: page.locator('[data-slot="list-scroll"]') })
  await expect(picker).toBeVisible({ timeout: 10_000 })
  // Wait until the grouped header is rendered — without this the snap can
  // race the first paint and capture an empty popover.
  await expect(picker.locator('[data-slot="list-header"]').first()).toBeVisible({
    timeout: 5_000,
  })
  return picker
}

test("model-picker-header", async ({ page, gotoSession }) => {
  test.setTimeout(180_000)

  await gotoSession()
  const lightPicker = await openModelPicker(page)
  const lightShot: Shot = { name: "light", buf: await lightPicker.screenshot() }

  await applyDarkModeForTests(page)
  await gotoSession()
  const darkPicker = await openModelPicker(page)
  const darkShot: Shot = { name: "dark", buf: await darkPicker.screenshot() }

  const out = snapOutputPath("model-picker-header")
  await composeGrid([lightShot, darkShot], out, { cols: 2 })
  process.stdout.write(`\n[snap] model-picker-header grid -> ${out}\n\n`)
})
