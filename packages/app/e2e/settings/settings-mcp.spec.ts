import { test, expect } from "../fixtures"
import { closeSettingsPanel, openSettings } from "../actions"

// Real user path for MCP management (issue #1485): open Settings → Integrations,
// add a local MCP server, confirm it lands in the list, edit it, toggle it off
// and on, then delete it. The e2e backend is a real opencode server, so this
// exercises the full stack: MCP Sheet → global.config.editMcp → global config
// write → re-bootstrap → list render (rendered from the raw, unexpanded config).
// The added server never actually connects (echo is not an MCP server), which is
// fine: the row is keyed on config, not on connection status.
test("add, edit, toggle, and delete an MCP server from the Integrations settings", async ({ page, gotoSession }) => {
  test.setTimeout(120_000)
  await gotoSession()

  const settings = await openSettings(page)
  await settings.getByRole("tab", { name: "Integrations" }).click()

  // Add
  await settings.getByRole("button", { name: "Add MCP server" }).click()
  const addSheet = page.locator('[data-component="sheet"]').filter({ has: page.getByText("Add MCP server") })
  await expect(addSheet).toBeVisible()
  await addSheet.getByLabel("Name").fill("e2e-mcp")
  await addSheet.getByLabel("Command").fill("echo hi")
  await addSheet.getByRole("button", { name: "Save server" }).click()
  await expect(addSheet).toHaveCount(0)

  // Appears in the list
  const row = settings.locator("li").filter({ hasText: "e2e-mcp" })
  await expect(row).toBeVisible()

  // Edit: the existing values are prefilled.
  await row.getByRole("button", { name: "Edit MCP server" }).click()
  const editSheet = page.locator('[data-component="sheet"]').filter({ has: page.getByText("Edit MCP server") })
  await expect(editSheet).toBeVisible()
  await expect(editSheet.getByLabel("Name")).toHaveValue("e2e-mcp")
  await editSheet.getByLabel("Command").fill("echo edited")
  await editSheet.getByRole("button", { name: "Save server" }).click()
  await expect(editSheet).toHaveCount(0)
  await expect(settings.locator("li").filter({ hasText: "e2e-mcp" })).toBeVisible()

  // Toggle: the switch carries the server name as its accessible name (screen
  // readers can tell the rows apart), and disabling then re-enabling round-trips
  // through the field-level `enable` patch without dropping the row. Click the
  // control (the real input sits under it); assert on the input's checked state.
  const toggle = settings.locator("li").filter({ hasText: "e2e-mcp" }).locator('[data-component="switch"]')
  const toggleInput = toggle.locator('[data-slot="switch-input"]')
  await expect(settings.getByRole("switch", { name: "Toggle e2e-mcp" })).toBeVisible()
  await expect(toggleInput).toBeChecked()
  await toggle.locator('[data-slot="switch-control"]').click()
  await expect(toggleInput).not.toBeChecked()
  await expect(toggleInput).toBeEnabled()
  await toggle.locator('[data-slot="switch-control"]').click()
  await expect(toggleInput).toBeChecked()

  // Delete: open edit, confirm delete, row disappears
  await settings
    .locator("li")
    .filter({ hasText: "e2e-mcp" })
    .getByRole("button", { name: "Edit MCP server" })
    .click()
  const deleteSheet = page.locator('[data-component="sheet"]').filter({ has: page.getByText("Edit MCP server") })
  await deleteSheet.getByRole("button", { name: "Delete server" }).click()
  const deleteDialog = page.getByRole("dialog").filter({ has: page.getByText("Delete e2e-mcp?") })
  await expect(deleteDialog).toBeVisible()
  await deleteDialog.getByRole("button", { name: "Delete server" }).click()
  await expect(deleteDialog).toHaveCount(0)
  await expect(deleteSheet).toHaveCount(0)
  await expect(settings.locator("li").filter({ hasText: "e2e-mcp" })).toHaveCount(0)

  await closeSettingsPanel(page, settings)
})

test("tests an unsaved MCP draft and keeps save available after failure", async ({ page, gotoSession }) => {
  test.setTimeout(120_000)
  await gotoSession()

  const settings = await openSettings(page)
  await settings.getByRole("tab", { name: "Integrations" }).click()
  await settings.getByRole("button", { name: "Add MCP server" }).click()

  const sheet = page.locator('[data-component="sheet"]').filter({ has: page.getByText("Add MCP server") })
  await sheet.getByRole("button", { name: "Remote" }).click()
  await sheet.getByLabel("URL").fill("not-a-url")
  await sheet.getByRole("button", { name: "Test connection" }).click()

  const result = sheet.getByRole("status")
  await expect(result).toContainText("Connection failed")
  await expect(result).toContainText('Invalid MCP URL for "draft"')
  await expect(result).toContainText("You can still save this server")
  await expect(sheet.getByRole("button", { name: "Save server" })).toBeEnabled()

  await sheet.getByRole("button", { name: "Cancel" }).click()
  await closeSettingsPanel(page, settings)
})

test("discards an in-flight connection result after the draft changes", async ({ page, gotoSession }) => {
  test.setTimeout(120_000)
  await gotoSession()

  let markStarted!: () => void
  const started = new Promise<void>((resolve) => (markStarted = resolve))
  let releaseResponse!: () => void
  const held = new Promise<void>((resolve) => (releaseResponse = resolve))
  await page.route("**/mcp/probe", async (route) => {
    markStarted()
    await held
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "connected" }) })
  })

  const settings = await openSettings(page)
  await settings.getByRole("tab", { name: "Integrations" }).click()
  await settings.getByRole("button", { name: "Add MCP server" }).click()
  const sheet = page.locator('[data-component="sheet"]').filter({ has: page.getByText("Add MCP server") })
  await sheet.getByRole("button", { name: "Remote" }).click()
  await sheet.getByLabel("URL").fill("https://old.example/mcp")
  await sheet.getByRole("button", { name: "Test connection" }).click()
  await started

  await sheet.getByLabel("URL").fill("https://new.example/mcp")
  releaseResponse()
  await expect(sheet.getByRole("button", { name: "Test connection" })).toBeEnabled()
  await expect(sheet.getByRole("status")).toHaveCount(0)

  await page.unroute("**/mcp/probe")
  await sheet.getByRole("button", { name: "Cancel" }).click()
  await closeSettingsPanel(page, settings)
})
