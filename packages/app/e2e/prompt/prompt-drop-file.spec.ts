import { test, expect } from "../fixtures"
import { promptSelector } from "../selectors"

// The shared e2e backend only exposes text-only models, so the image-attach
// happy path cannot be exercised here. These specs lock in the two paths the
// drop-file pipeline owns under that constraint:
//   1. dropping an image with a text-only model surfaces the "choose a vision
//      model" toast and never adds a chip
//   2. dropping a non-image file routes through addDirect and renders a chip
//      with a Remove control

test("dropping an image with a text-only model surfaces the unsupported toast", async ({ page, gotoSession }) => {
  await gotoSession()

  const prompt = page.locator(promptSelector)
  await prompt.click()

  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO3+4uQAAAAASUVORK5CYII="
  const dt = await page.evaluateHandle((b64) => {
    const dt = new DataTransfer()
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const file = new File([bytes], "drop.png", { type: "image/png" })
    dt.items.add(file)
    return dt
  }, png)

  await page.dispatchEvent("body", "drop", { dataTransfer: dt })

  await expect(page.getByText("This model cannot read images")).toBeVisible()
  await expect(page.getByRole("button", { name: "Choose model" })).toBeVisible()
  await expect(page.locator('img[alt="drop.png"]')).toHaveCount(0)
})

test("dropping a text file adds a removable attachment chip", async ({ page, gotoSession }) => {
  await gotoSession()

  const prompt = page.locator(promptSelector)
  await prompt.click()

  const dt = await page.evaluateHandle(() => {
    const dt = new DataTransfer()
    const file = new File(["hello from drop"], "drop.txt", { type: "text/plain" })
    dt.items.add(file)
    return dt
  })

  await page.dispatchEvent("body", "drop", { dataTransfer: dt })

  const chip = page.getByText("drop.txt").first()
  await expect(chip).toBeVisible()
  await chip.hover()

  const remove = page.getByRole("button", { name: "Remove attachment" }).first()
  await expect(remove).toBeVisible()
  await remove.click()
  await expect(page.getByText("drop.txt")).toHaveCount(0)
})
