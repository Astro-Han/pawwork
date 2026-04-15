import { test, expect } from "../fixtures"
import { modKey } from "../utils"

const expanded = async (el: { getAttribute: (name: string) => Promise<string | null> }) => {
  const value = await el.getAttribute("aria-expanded")
  if (value !== "true" && value !== "false") throw new Error(`Expected aria-expanded to be true|false, got: ${value}`)
  return value === "true"
}

test("desktop side-panel buttons switch between review and files without an in-panel tab strip", async ({
  page,
  gotoSession,
}) => {
  await gotoSession()

  const reviewPanel = page.locator("#review-panel")
  const reviewToggle = page.getByRole("button", { name: "Toggle review" }).first()
  const fileToggle = page.getByRole("button", { name: "Toggle file tree" }).first()

  await expect(reviewToggle).toBeVisible()
  await expect(fileToggle).toBeVisible()

  if (await expanded(reviewToggle)) await reviewToggle.click()
  if (await expanded(fileToggle)) await fileToggle.click()

  await expect(reviewPanel.getByRole("tab", { name: "Files" })).toHaveCount(0)
  await expect(reviewPanel.getByRole("tab", { name: "Changes" })).toHaveCount(0)

  await reviewToggle.click()
  await expect(reviewToggle).toHaveAttribute("aria-expanded", "true")
  await expect(fileToggle).toHaveAttribute("aria-expanded", "false")
  await expect(reviewPanel).toHaveAttribute("aria-hidden", "false")

  await fileToggle.click()
  await expect(reviewToggle).toHaveAttribute("aria-expanded", "false")
  await expect(fileToggle).toHaveAttribute("aria-expanded", "true")
  await expect(reviewPanel).toHaveAttribute("aria-hidden", "false")

  await fileToggle.click()
  await expect(fileToggle).toHaveAttribute("aria-expanded", "false")
  await expect(reviewToggle).toHaveAttribute("aria-expanded", "false")
  await expect(reviewPanel).toHaveAttribute("aria-hidden", "true")

  await page.keyboard.press(`${modKey}+Shift+R`)
  await expect(reviewToggle).toHaveAttribute("aria-expanded", "true")
  await expect(fileToggle).toHaveAttribute("aria-expanded", "false")
  await expect(reviewPanel).toHaveAttribute("aria-hidden", "false")
})
