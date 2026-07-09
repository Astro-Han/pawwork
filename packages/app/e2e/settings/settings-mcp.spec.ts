import { test, expect } from "../fixtures"
import { closeSettingsPanel, openSettings } from "../actions"

// Real user path for MCP management (issue #1485): open Settings → Integrations,
// add a local MCP server, confirm it lands in the list, edit it, then delete it.
// The e2e backend is a real opencode server, so this exercises the full stack:
// DialogMcpForm → global.config.editMcp → global config write → re-bootstrap →
// list render. The added server never actually connects (echo is not an MCP
// server), which is fine: the row is keyed on config, not on connection status.
test("add, edit, and delete an MCP server from the Integrations settings", async ({ page, gotoSession }) => {
  test.setTimeout(120_000)
  await gotoSession()

  const settings = await openSettings(page)
  await settings.getByRole("tab", { name: "Integrations" }).click()

  // Add
  await settings.getByRole("button", { name: "Add MCP server" }).click()
  const addDialog = page.getByRole("dialog").filter({ has: page.getByText("Add MCP server") })
  await expect(addDialog).toBeVisible()
  await addDialog.getByLabel("Name").fill("e2e-mcp")
  await addDialog.getByLabel("Command").fill("echo hi")
  await addDialog.getByRole("button", { name: "Save" }).click()
  await expect(addDialog).toHaveCount(0)

  // Appears in the list
  const row = settings.locator("li").filter({ hasText: "e2e-mcp" })
  await expect(row).toBeVisible()

  // Edit: name is read-only (rename is not offered in v1 via this field), command prefilled
  await row.getByRole("button", { name: "Edit MCP server" }).click()
  const editDialog = page.getByRole("dialog").filter({ has: page.getByText("Edit MCP server") })
  await expect(editDialog).toBeVisible()
  await expect(editDialog.getByLabel("Name")).toHaveValue("e2e-mcp")
  await editDialog.getByLabel("Command").fill("echo edited")
  await editDialog.getByRole("button", { name: "Save" }).click()
  await expect(editDialog).toHaveCount(0)
  await expect(settings.locator("li").filter({ hasText: "e2e-mcp" })).toBeVisible()

  // Delete: open edit, confirm delete, row disappears
  await settings
    .locator("li")
    .filter({ hasText: "e2e-mcp" })
    .getByRole("button", { name: "Edit MCP server" })
    .click()
  const deleteDialog = page.getByRole("dialog").filter({ has: page.getByText("Edit MCP server") })
  await deleteDialog.getByRole("button", { name: "Delete" }).click()
  // Inline confirm swaps in a second Delete; click it to commit.
  await deleteDialog.getByRole("button", { name: "Delete" }).click()
  await expect(deleteDialog).toHaveCount(0)
  await expect(settings.locator("li").filter({ hasText: "e2e-mcp" })).toHaveCount(0)

  await closeSettingsPanel(page, settings)
})
