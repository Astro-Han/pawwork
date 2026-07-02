import { test } from "../fixtures"
import { openSettings } from "../actions"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

// Review the settings route's shell slots + left nav (back-to-app + 6 tabs + version footer).
// Currently 6 tabs: General / Shortcuts / Models / Integrations / Worktrees / Memory
// (remote access still hidden until ready).
// Capture 4 shots: General (default) / Models / Integrations / Memory.
test("settings-shell", async ({ page, project }) => {
  test.setTimeout(180_000)

  await project.open()

  const settings = await openSettings(page)
  await settings.waitFor({ state: "visible", timeout: 30_000 })

  const shots: Shot[] = [{ name: "general", buf: await settings.screenshot() }]

  // Wait for each tab's content to render before snapping, instead of a fixed delay.
  const tabReady = {
    Models: '[data-component="custom-provider-section"]',
    Integrations: '[data-component="settings-integrations"]',
    Memory: '[data-action="settings-memory-raw"]',
  } as const

  for (const tab of ["Models", "Integrations", "Memory"] as const) {
    await settings.getByRole("tab", { name: tab }).click()
    await settings.locator(tabReady[tab]).first().waitFor({ state: "visible", timeout: 30_000 })
    shots.push({ name: tab.toLowerCase(), buf: await settings.screenshot() })
  }

  const out = snapOutputPath("settings-shell")
  await composeGrid(shots, out)
  process.stdout.write(`\n[snap] settings-shell grid -> ${out}\n\n`)
})
