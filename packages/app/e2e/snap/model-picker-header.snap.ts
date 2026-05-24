import type { Locator, Page } from "@playwright/test"
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

// Locked computed-style invariants for the picker grouped header. Asserted
// in addition to the screenshot because the visible `data-stuck` regression
// path only paints once the user scrolls — fixture has too few models to
// guarantee an overflowing picker, so a snap alone cannot reach it. These
// two reads exercise the rule directly: a future selector demotion or token
// drift fails the test even though the screenshot would still pass.
async function assertHeaderInvariants(picker: Locator) {
  const header = picker.locator('[data-slot="list-header"]').first()
  await expect(header).toBeVisible()

  const computed = await header.evaluate((el) => {
    const headerStyle = window.getComputedStyle(el)
    const afterStyle = window.getComputedStyle(el, "::after")
    const expectedSurface = window
      .getComputedStyle(document.documentElement)
      .getPropertyValue("--surface-raised")
      .trim()
    const probe = document.createElement("span")
    probe.style.color = expectedSurface
    document.body.appendChild(probe)
    const expectedRgb = window.getComputedStyle(probe).color
    probe.remove()
    return {
      headerBg: headerStyle.backgroundColor,
      headerPosition: headerStyle.position,
      afterDisplay: afterStyle.display,
      expectedRgb,
    }
  })

  // `position: static` is the picker-scoped override that disables the
  // sticky header. If the picker.css selector drops below list.css's 0,4,0
  // chain again, position flips back to sticky and this fails.
  expect(computed.headerPosition).toBe("static")
  // Header surface must match the picker body's --surface-raised, not List's
  // default --surface-base.
  expect(computed.headerBg).toBe(computed.expectedRgb)
  // ::after is the 16px stuck gradient. Hiding it is the second half of the
  // fix; without this assertion, only a scroll-driven snap could catch its
  // re-emergence.
  expect(computed.afterDisplay).toBe("none")
}

test("model-picker-header", async ({ page, gotoSession }) => {
  test.setTimeout(180_000)

  await gotoSession()
  const lightPicker = await openModelPicker(page)
  await assertHeaderInvariants(lightPicker)
  const lightShot: Shot = { name: "light", buf: await lightPicker.screenshot() }

  await applyDarkModeForTests(page)
  await gotoSession()
  const darkPicker = await openModelPicker(page)
  await assertHeaderInvariants(darkPicker)
  const darkShot: Shot = { name: "dark", buf: await darkPicker.screenshot() }

  const out = snapOutputPath("model-picker-header")
  await composeGrid([lightShot, darkShot], out, { cols: 2 })
  process.stdout.write(`\n[snap] model-picker-header grid -> ${out}\n\n`)
})
