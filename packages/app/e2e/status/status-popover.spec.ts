import { test, expect } from "../fixtures"
import { rightPanelTabList } from "../actions"
import { titlebarRightSelector } from "../selectors"

test("desktop right-panel toggle opens the status tab by default", async ({ page, gotoSession }) => {
  await gotoSession()

  const rightToggle = page.locator(`${titlebarRightSelector} button`).first()
  const rightPanel = page.locator("#right-panel")
  const shellTabList = rightPanelTabList(page)

  await expect(rightPanel).toHaveAttribute("aria-hidden", "true")

  await rightToggle.click()

  await expect(rightPanel).toHaveAttribute("aria-hidden", "false")
  await expect(shellTabList.getByRole("tab", { name: "Status", exact: true })).toHaveAttribute("aria-selected", "true")
  // Servers/MCP/LSP/Plugins render as collapsible SectionRow `<button aria-expanded>`
  // inside the Status panel body (see SessionStatusConnections.SectionRow) —
  // not as `role="tab"`. Mobile still uses tabs in the popover (separate test below).
  await expect(rightPanel.getByRole("button", { name: /servers/i })).toBeVisible()
  await expect(rightPanel.getByRole("button", { name: /mcp/i })).toBeVisible()
  await expect(rightPanel.getByRole("button", { name: /lsp/i })).toBeVisible()
  await expect(rightPanel.getByRole("button", { name: /plugins/i })).toBeVisible()
})

test("session status panel can expand mcp section", async ({ page, gotoSession }) => {
  await gotoSession()

  const rightToggle = page.locator(`${titlebarRightSelector} button`).first()
  const rightPanel = page.locator("#right-panel")

  await rightToggle.click()

  // MCP section is a collapsible <button aria-expanded> row in the Status panel,
  // not a tab — click toggles aria-expanded and reveals the section body.
  const mcpRow = rightPanel.getByRole("button", { name: /mcp/i })
  await expect(mcpRow).toHaveAttribute("aria-expanded", "false")
  await mcpRow.click()
  await expect(mcpRow).toHaveAttribute("aria-expanded", "true")
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
