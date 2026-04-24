import { expect, test } from "../fixtures"
import { promptSelector, sessionComposerDockSelector } from "../selectors"

test("send disabled on empty input", async ({ page, project }) => {
  await project.open()
  const send = page.locator(sessionComposerDockSelector).locator('[data-action="prompt-submit"]')
  await expect(send).toBeDisabled()
})

test("send enabled with non-empty input", async ({ page, project }) => {
  await project.open()
  const prompt = page.locator(promptSelector)
  await prompt.click()
  await page.keyboard.type("hello")
  const send = page.locator(sessionComposerDockSelector).locator('[data-action="prompt-submit"]')
  await expect(send).toBeEnabled()
})
