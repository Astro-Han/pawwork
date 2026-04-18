import { test, expect } from "../fixtures"
import { modKey } from "../utils"

const expanded = async (el: { getAttribute: (name: string) => Promise<string | null> }) => {
  const value = await el.getAttribute("aria-expanded")
  if (value !== "true" && value !== "false") throw new Error(`Expected aria-expanded to be true|false, got: ${value}`)
  return value === "true"
}

test("desktop side-panel buttons switch between review and files within a unified right-panel tab shell", async ({
  page,
  gotoSession,
}) => {
  await gotoSession()

  const rightPanel = page.locator("#right-panel")
  const reviewToggle = page.getByRole("button", { name: "Toggle review" }).first()
  const fileToggle = page.getByRole("button", { name: "Toggle file tree" }).first()

  await expect(reviewToggle).toBeVisible()
  await expect(fileToggle).toBeVisible()

  if (await expanded(reviewToggle)) await reviewToggle.click()
  if (await expanded(fileToggle)) await fileToggle.click()

  await reviewToggle.click()
  await expect(reviewToggle).toHaveAttribute("aria-expanded", "true")
  await expect(fileToggle).toHaveAttribute("aria-expanded", "false")
  await expect(rightPanel).toHaveAttribute("aria-hidden", "false")
  const shellTabList = rightPanel.getByRole("tablist").first()
  await expect(shellTabList.getByRole("tab", { name: "Status", exact: true })).toBeVisible()
  await expect(shellTabList.getByRole("tab", { name: "Files", exact: true })).toBeVisible()
  await expect(shellTabList.getByRole("tab", { name: "Review", exact: true })).toBeVisible()
  await expect(shellTabList.getByRole("tab", { name: "Terminal", exact: true })).toBeVisible()
  await expect(shellTabList.getByRole("tab", { name: "Review", exact: true })).toHaveAttribute("aria-selected", "true")

  await fileToggle.click()
  await expect(reviewToggle).toHaveAttribute("aria-expanded", "false")
  await expect(fileToggle).toHaveAttribute("aria-expanded", "true")
  await expect(rightPanel).toHaveAttribute("aria-hidden", "false")
  await expect(shellTabList.getByRole("tab", { name: "Files", exact: true })).toHaveAttribute("aria-selected", "true")

  await fileToggle.click()
  await expect(fileToggle).toHaveAttribute("aria-expanded", "false")
  await expect(reviewToggle).toHaveAttribute("aria-expanded", "false")
  await expect(rightPanel).toHaveAttribute("aria-hidden", "true")

  await page.keyboard.press(`${modKey}+Shift+R`)
  await expect(reviewToggle).toHaveAttribute("aria-expanded", "true")
  await expect(fileToggle).toHaveAttribute("aria-expanded", "false")
  await expect(rightPanel).toHaveAttribute("aria-hidden", "false")
  await expect(shellTabList.getByRole("tab", { name: "Review", exact: true })).toHaveAttribute("aria-selected", "true")
})
