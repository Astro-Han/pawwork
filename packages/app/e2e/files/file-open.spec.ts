import fs from "node:fs/promises"
import path from "node:path"
import { test, expect } from "../fixtures"
import { promptSelector } from "../selectors"

test("can open a file tab from the search palette", async ({ page, project }) => {
  const fileName = `i501-open-target-${Date.now()}.txt`
  await project.open({
    setup: async (directory) => {
      await fs.writeFile(path.join(directory, fileName), "open target\n")
    },
  })

  await page.locator(promptSelector).click()
  await page.keyboard.type("/open")

  const command = page.locator('[data-slash-id="file.open"]').first()
  await expect(command).toBeVisible()
  await page.keyboard.press("Enter")

  const dialog = page
    .getByRole("dialog")
    .filter({ has: page.getByPlaceholder(/search files/i) })
    .first()
  await expect(dialog).toBeVisible()

  const input = dialog.getByRole("textbox").first()
  await input.fill("previous session")
  await expect(dialog.locator('[data-slot="list-item"][data-key^="command:"]')).toHaveCount(0)
  await expect(dialog.locator('[data-slot="list-item"][data-key^="session:"]')).toHaveCount(0)

  await input.fill(fileName)

  const item = dialog.locator(`[data-slot="list-item"][data-key="file:${fileName}"]`)
  await expect(item).toBeVisible({ timeout: 30_000 })
  await item.click()

  await expect(dialog).toHaveCount(0)

  const tabs = page.locator('[data-component="tabs"][data-variant="normal"]')
  await expect(tabs.locator('[data-slot="tabs-trigger"]').first()).toBeVisible()
})
