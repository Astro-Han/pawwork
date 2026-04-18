import { test, expect } from "../fixtures"
import { openStatusPopover } from "../actions"

test("@smoke home renders and shows core entrypoints", async ({ page }) => {
  await page.goto("/")

  await expect(page.getByRole("button", { name: "Open project" }).first()).toBeVisible()
  await expect(page.getByRole("heading", { name: "Choose what to do" })).toBeVisible()
  await expect(page.getByRole("button", { name: /Process documents/i })).toBeVisible()
  await expect(page.getByRole("button", { name: /Analyze data/i })).toBeVisible()
  await expect(page.getByRole("button", { name: /Write faster/i })).toBeVisible()
  await expect(page.getByRole("button", { name: "Status" })).toBeVisible()
})

test("@smoke server picker dialog opens from home", async ({ page }) => {
  await page.goto("/")
  const { popoverBody } = await openStatusPopover(page)
  await popoverBody.getByRole("button", { name: "Manage servers" }).click()

  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole("textbox").first()).toBeVisible()
})
