import fs from "node:fs/promises"
import path from "node:path"
import { test, expect } from "../fixtures"
import { closeDialog, openPalette } from "../actions"

test("search palette opens and closes", async ({ page, gotoSession }) => {
  await gotoSession()

  const dialog = await openPalette(page)

  await page.keyboard.press("Escape")
  await expect(dialog).toHaveCount(0)
})

test("search palette also opens with cmd+p", async ({ page, gotoSession }) => {
  await gotoSession()

  const dialog = await openPalette(page, "P")

  await closeDialog(page, dialog)
  await expect(dialog).toHaveCount(0)
})

test("command palette default view shows the fixed command map", async ({ page, gotoSession }) => {
  await gotoSession()

  const dialog = await openPalette(page)

  await expect(dialog.locator('[data-slot="list-header"]')).toHaveText([
    "Suggested",
    "Navigation",
    "Panels",
    "Configure",
  ])
  await expect(dialog.locator('[data-slot="list-item"][data-key="command:session.new"]')).toBeVisible()
  await expect(dialog.locator('[data-slot="list-item"][data-key="command:file.open"]')).toBeVisible()
  await expect(dialog.locator('[data-slot="list-item"][data-key="command:session.previous"]')).toBeVisible()
  await expect(dialog.locator('[data-slot="list-item"][data-key="command:session.compact"]')).toHaveCount(0)
  await expect(dialog.locator('[data-slot="list-item"][data-key^="session:"]')).toHaveCount(0)
  await expect(dialog.locator('[data-slot="list-item"][data-key^="file:"]')).toHaveCount(0)
})

test("typed command palette search keeps lower-frequency commands searchable", async ({ page, gotoSession }) => {
  await gotoSession()

  const dialog = await openPalette(page)
  await dialog.getByRole("textbox").fill("unread")

  await expect(dialog.locator('[data-slot="list-item"][data-key="command:session.previous.unseen"]')).toBeVisible()
})

test("typed command palette search still returns files", async ({ page, project }) => {
  const fileName = `i501-palette-target-${Date.now()}.txt`
  await project.open({
    setup: async (directory) => {
      await fs.writeFile(path.join(directory, fileName), "palette target\n")
    },
  })

  const dialog = await openPalette(page)
  await dialog.getByRole("textbox").fill(fileName)

  await expect(dialog.locator(`[data-slot="list-item"][data-key="file:${fileName}"]`)).toBeVisible({ timeout: 30_000 })
})
