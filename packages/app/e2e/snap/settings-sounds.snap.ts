import { test } from "../fixtures"
import { openSettings } from "../actions"
import { settingsSoundsAgentSelector } from "../selectors"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

test("settings-sounds", async ({ page, project }) => {
  test.setTimeout(180_000)

  await project.open()

  const settings = await openSettings(page)
  const select = settings.locator(settingsSoundsAgentSelector)
  await select.scrollIntoViewIfNeeded()
  await select.waitFor({ state: "visible", timeout: 30_000 })

  const shots: Shot[] = [{ name: "section", buf: await settings.screenshot() }]

  // Open the agent-sound dropdown to show the reduced option set
  // (None / Notification / Error) rendered in the portal.
  await select.locator('[data-slot="select-select-trigger"]').click()
  await page
    .locator('[data-slot="select-select-item"]')
    .first()
    .waitFor({ state: "visible", timeout: 10_000 })
  shots.push({ name: "agent-options", buf: await page.screenshot() })

  const out = snapOutputPath("settings-sounds")
  await composeGrid(shots, out)
  process.stdout.write(`\n[snap] settings-sounds grid -> ${out}\n\n`)
})
