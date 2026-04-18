import { test, expect } from "../fixtures"

test("session status button opens the right-panel status tab", async ({ page, gotoSession }) => {
  await gotoSession()

  const statusButton = page.getByRole("button", { name: "Status" }).first()
  const rightPanel = page.locator("#right-panel")
  const shellTabList = rightPanel.getByRole("tablist").first()

  await expect(rightPanel).toHaveAttribute("aria-hidden", "true")

  await statusButton.click()

  await expect(rightPanel).toHaveAttribute("aria-hidden", "false")
  await expect(shellTabList.getByRole("tab", { name: "Status", exact: true })).toHaveAttribute("aria-selected", "true")
  await expect(rightPanel.getByRole("tab", { name: /servers/i })).toBeVisible()
  await expect(rightPanel.getByRole("tab", { name: /mcp/i })).toBeVisible()
  await expect(rightPanel.getByRole("tab", { name: /lsp/i })).toBeVisible()
  await expect(rightPanel.getByRole("tab", { name: /plugins/i })).toBeVisible()
})

test("session status tab can switch to mcp", async ({ page, gotoSession }) => {
  await gotoSession()

  const statusButton = page.getByRole("button", { name: "Status" }).first()
  const rightPanel = page.locator("#right-panel")

  await statusButton.click()

  const mcpTab = rightPanel.getByRole("tab", { name: /mcp/i })
  await mcpTab.click()
  await expect(mcpTab).toHaveAttribute("aria-selected", "true")
  await expect(rightPanel.locator('[role="tabpanel"]:visible').first()).toBeVisible()
})

test("session status button toggles the right panel closed", async ({ page, gotoSession }) => {
  await gotoSession()

  const statusButton = page.getByRole("button", { name: "Status" }).first()
  const rightPanel = page.locator("#right-panel")

  await statusButton.click()
  await expect(rightPanel).toHaveAttribute("aria-hidden", "false")

  await statusButton.click()
  await expect(rightPanel).toHaveAttribute("aria-hidden", "true")
})
