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

test("command palette sticky group headers cover scrolled commands", async ({ page, gotoSession }) => {
  await gotoSession()

  const dialog = await openPalette(page)
  const scroll = dialog.locator('[data-slot="list-scroll"]')
  await scroll.evaluate((node) => {
    node.scrollTop = 64
  })

  const header = dialog.locator('[data-slot="list-header"]').first()
  const background = await header.evaluate((node) => getComputedStyle(node).backgroundColor)
  expect(background).not.toBe("rgba(0, 0, 0, 0)")

  const coveredByItem = await dialog.evaluate((node) => {
    const scroll = node.querySelector('[data-slot="list-scroll"]')
    if (!scroll) return false
    const rect = scroll.getBoundingClientRect()
    const topNode = document.elementFromPoint(rect.left + 24, rect.top + 4)
    return !!topNode?.closest('[data-slot="list-item"]')
  })
  expect(coveredByItem).toBe(false)
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
