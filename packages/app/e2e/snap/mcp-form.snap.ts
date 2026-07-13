import type { Locator, Page } from "@playwright/test"
import { test } from "../fixtures"
import { openSettings } from "../actions"
import { applyDarkModeForTests } from "../utils"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

// Visual contract for the MCP management form (issue #1485). Opens Settings →
// Integrations → Add MCP server and captures the right-side Sheet in light and
// dark. Guards its warm neutral surfaces, type/auth controls, content density,
// and action hierarchy as one visual contract.
test.use({ viewport: { width: 900, height: 760 }, deviceScaleFactor: 2 })

async function openMcpForm(page: Page): Promise<Locator> {
  const settings = await openSettings(page)
  await settings.getByRole("tab", { name: "Integrations" }).click()
  await settings.getByRole("button", { name: "Add MCP server" }).click()
  const sheet = page.locator('[data-component="sheet"]').filter({ has: page.getByText("Add MCP server") })
  await sheet.waitFor({ state: "visible" })
  // Fill a little so the form reads as a real editing surface, not empty fields.
  await sheet.getByLabel("Name").fill("filesystem")
  await sheet.getByLabel("Command").fill("npx -y @modelcontextprotocol/server-filesystem /work")
  await page.waitForTimeout(250)
  return sheet
}

test("mcp-form", async ({ page, gotoSession }) => {
  test.setTimeout(180_000)

  await gotoSession()
  const lightSheet = await openMcpForm(page)
  const lightShot: Shot = { name: "light-local", buf: await lightSheet.screenshot() }

  await applyDarkModeForTests(page)
  await gotoSession()
  const darkSheet = await openMcpForm(page)
  await darkSheet.getByRole("button", { name: "Remote" }).click()
  await darkSheet.getByLabel("URL").fill("https://api.example.com/mcp")
  await darkSheet.getByLabel("Bearer token").fill("{env:MCP_TOKEN}")
  const darkShot: Shot = { name: "dark-remote", buf: await darkSheet.screenshot() }

  const out = snapOutputPath("mcp-form")
  await composeGrid([lightShot, darkShot], out, { cols: 2 })
  process.stdout.write(`\n[snap] mcp-form grid -> ${out}\n\n`)
})
