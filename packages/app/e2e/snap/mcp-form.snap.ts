import type { Locator, Page } from "@playwright/test"
import { test } from "../fixtures"
import { openSettings } from "../actions"
import { applyDarkModeForTests } from "../utils"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

// Visual contract for the MCP management form (issue #1485). Opens Settings →
// Integrations → Add MCP server and captures the DialogMcpForm in light and
// dark. Guards the form's reuse of the shared Dialog / TextField / segmented
// chrome (warm neutrals, single orange accent, hairline borders) so a drift in
// spacing, surface, or control styling is caught here.
test.use({ viewport: { width: 900, height: 760 }, deviceScaleFactor: 2 })

async function openMcpForm(page: Page): Promise<Locator> {
  const settings = await openSettings(page)
  await settings.getByRole("tab", { name: "Integrations" }).click()
  await settings.getByRole("button", { name: "Add MCP server" }).click()
  const dialog = page.locator('[data-component="dialog"] [data-slot="dialog-content"]').first()
  await dialog.waitFor({ state: "visible" })
  // Fill a little so the form reads as a real editing surface, not empty fields.
  await dialog.getByLabel("Name").fill("filesystem")
  await dialog.getByLabel("Command").fill("npx -y @modelcontextprotocol/server-filesystem /work")
  return dialog
}

test("mcp-form", async ({ page, gotoSession }) => {
  test.setTimeout(180_000)

  await gotoSession()
  const lightDialog = await openMcpForm(page)
  const lightShot: Shot = { name: "light", buf: await lightDialog.screenshot() }

  await applyDarkModeForTests(page)
  await gotoSession()
  const darkDialog = await openMcpForm(page)
  const darkShot: Shot = { name: "dark", buf: await darkDialog.screenshot() }

  const out = snapOutputPath("mcp-form")
  await composeGrid([lightShot, darkShot], out, { cols: 2 })
  process.stdout.write(`\n[snap] mcp-form grid -> ${out}\n\n`)
})
