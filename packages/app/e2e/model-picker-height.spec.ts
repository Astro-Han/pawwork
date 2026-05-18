import { test, expect } from "./fixtures"
import { promptModelSelector } from "./selectors"

const pickerContentSelector = '[data-picker-content=""]'
const thinkingTriggerSelector = '[data-action="prompt-model-thinking-trigger"]'

test("model picker height fits content, no empty bottom space", async ({ page, gotoSession }, testInfo) => {
  await gotoSession()

  const chip = page.locator(promptModelSelector).locator('[data-action="prompt-model"]').first()
  await expect(chip).toBeVisible()
  await chip.click()

  // Variant (Thinking) sub-popover also uses [data-picker-content]; scope by the
  // model list scroll container so the locator stays unambiguous if both render.
  const picker = page
    .locator(pickerContentSelector)
    .filter({ has: page.locator('[data-slot="list-scroll"]') })
  await expect(picker).toBeVisible()

  const thinking = page.locator(thinkingTriggerSelector)
  await expect(thinking).toBeVisible()

  const items = picker.locator('[data-slot="list-item"]')
  const itemCount = await items.count()
  expect(itemCount, "expected at least one model in the picker").toBeGreaterThan(0)
  const lastItem = items.nth(itemCount - 1)

  const pickerBox = await picker.boundingBox()
  const lastItemBox = await lastItem.boundingBox()
  const thinkingBox = await thinking.boundingBox()
  if (!pickerBox || !lastItemBox || !thinkingBox) throw new Error("picker layout box missing")

  // The model list and the Thinking row are stacked in a flex-col. Between the last
  // visible model and the Thinking row only the list's own gap (12px) plus the
  // section's border + padding belong. When the popover is forced to a fixed 400px
  // and the model list happens to be short, the list-scroll grows to fill flex-1
  // and an empty band appears above the Thinking row.
  const scrollHeight = await picker
    .locator('[data-slot="list-scroll"]')
    .evaluate((el) => el.scrollHeight)
  const clientHeight = await picker
    .locator('[data-slot="list-scroll"]')
    .evaluate((el) => el.clientHeight)
  const listOverflowing = scrollHeight > clientHeight + 1

  const lastItemBottom = lastItemBox.y + lastItemBox.height
  const gapBelowLastItem = thinkingBox.y - lastItemBottom

  // If the list scrolls, the last DOM item may be clipped offscreen, so we only
  // require the no-empty-band invariant when the content fits without scrolling.
  if (!listOverflowing) {
    expect(
      gapBelowLastItem,
      "no empty band should appear between last model and Thinking row",
    ).toBeLessThan(40)
  }

  expect(pickerBox.height, "popover height should not exceed the 400px cap").toBeLessThanOrEqual(400)

  const screenshotPath = testInfo.outputPath("model-picker.png")
  await picker.screenshot({ path: screenshotPath })
  await testInfo.attach("model-picker", { path: screenshotPath, contentType: "image/png" })
})
