import { test, expect } from "../fixtures"
import { titlebarRightSelector } from "../selectors"

test("desktop right-panel toggle opens the status tab by default", async ({ page, gotoSession }) => {
  await gotoSession()

  const rightToggle = page.locator(`${titlebarRightSelector} button`).first()
  const rightPanel = page.locator("#right-panel")
  const shellTabList = rightPanel.getByRole("tablist").first()

  await expect(rightPanel).toHaveAttribute("aria-hidden", "true")

  await rightToggle.click()

  await expect(rightPanel).toHaveAttribute("aria-hidden", "false")
  await expect(shellTabList.getByRole("tab", { name: "Status", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(rightPanel.getByRole("tab", { name: /servers/i })).toBeVisible()
  await expect(rightPanel.getByRole("tab", { name: /mcp/i })).toBeVisible()
  await expect(rightPanel.getByRole("tab", { name: /lsp/i })).toBeVisible()
  await expect(rightPanel.getByRole("tab", { name: /plugins/i })).toBeVisible()
})

test("session status tab can switch to mcp", async ({ page, gotoSession }) => {
  await gotoSession()

  const rightToggle = page.locator(`${titlebarRightSelector} button`).first()
  const rightPanel = page.locator("#right-panel")

  await rightToggle.click()

  const mcpTab = rightPanel.getByRole("tab", { name: /mcp/i })
  await mcpTab.click()
  await expect(mcpTab).toHaveAttribute("aria-selected", "true")
  await expect(rightPanel.locator('[role="tabpanel"]:visible').first()).toBeVisible()
})

test("desktop right-panel toggle closes the right panel", async ({ page, gotoSession }) => {
  await gotoSession()

  const rightToggle = page.locator(`${titlebarRightSelector} button`).first()
  const rightPanel = page.locator("#right-panel")

  await rightToggle.click()
  await expect(rightPanel).toHaveAttribute("aria-hidden", "false")

  await rightToggle.click()
  await expect(rightPanel).toHaveAttribute("aria-hidden", "true")
})

test("mobile session status button still opens the status popover", async ({ page, gotoSession }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await gotoSession()

  const statusButton = page.getByRole("button", { name: "Status" }).first()
  const popoverBody = page.locator('[data-slot="popover-body"]').filter({ has: page.locator('[data-component="tabs"]') })

  await statusButton.click()
  await expect(popoverBody).toBeVisible()
  await expect(popoverBody.getByRole("tab", { name: /servers/i })).toBeVisible()
})
