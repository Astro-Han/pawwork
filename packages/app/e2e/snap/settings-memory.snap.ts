import { test } from "../fixtures"
import { openSettings } from "../actions"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

test("settings-memory", async ({ page, project }) => {
  test.setTimeout(180_000)

  await project.open()
  await project.sdk.memory.reset()

  const settings = await openSettings(page)
  await settings.getByRole("tab", { name: "Memory" }).click()

  const panel = settings.locator("section").nth(0).locator("..")
  await panel.waitFor({ state: "visible", timeout: 30_000 })

  const shots: Shot[] = [
    { name: "default", buf: await settings.screenshot() },
  ]
  const out = snapOutputPath("settings-memory")
  await composeGrid(shots, out)
  process.stdout.write(`\n[snap] settings-memory grid -> ${out}\n\n`)
})
