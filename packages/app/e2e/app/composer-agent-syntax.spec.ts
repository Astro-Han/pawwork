import { expect, test } from "../fixtures"
import { promptSelector } from "../selectors"

test("@ in composer triggers agent popover", async ({ page, project }) => {
  await project.open()
  const prompt = page.locator(promptSelector)
  await prompt.click()
  await page.keyboard.type("@")

  const popover = page.locator('[data-component="prompt-at-popover"]')
  await expect(popover).toBeVisible()
})

test("selecting an agent inserts an agent pill", async ({ page, project }) => {
  await project.open()
  const prompt = page.locator(promptSelector)
  await prompt.click()
  await page.keyboard.type("@")

  // wait for the @ popover before pressing Enter to avoid racing the mount
  const popover = page.locator('[data-component="prompt-at-popover"]')
  await expect(popover).toBeVisible()

  await page.keyboard.press("Enter")

  const pill = prompt.locator('[data-type="agent"]').first()
  await expect(pill).toBeVisible()
})
