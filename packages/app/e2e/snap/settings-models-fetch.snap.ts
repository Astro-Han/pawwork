import { test, expect } from "../fixtures"
import { openSettings } from "../actions"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

// Visual contract for the Settings > Models "Fetch models" action (issue #1463): an OpenAI-compatible
// provider group shows a ghost button with the refresh icon in its header, above the model rows. The
// default OpenCode Zen provider is OpenAI-compatible, so the button renders without seeding anything.
// Captured at rest — clicking would call the provider's live /models endpoint.
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

test("settings-models-fetch", async ({ page, project }) => {
  test.setTimeout(180_000)

  await project.open()

  // App-shell toasts (e.g. server health checks) float over the page and bleed into block screenshots;
  // they are environment chrome, not the surface under test.
  await page.addStyleTag({ content: '[data-component="toast-region"] { display: none; }' })

  const settings = await openSettings(page)
  await settings.getByRole("tab", { name: "Models" }).click()

  const fetchButton = settings.getByRole("button", { name: "Fetch models" }).first()
  await expect(fetchButton).toBeVisible({ timeout: 30_000 })
  await fetchButton.scrollIntoViewIfNeeded()

  // Frame the provider group (button -> header (..) -> group (..)) so the shot stays on the header +
  // model rows rather than the providers list stacked above it.
  const group = fetchButton.locator("xpath=../..")
  await expect(group).toBeVisible({ timeout: 10_000 })

  const shots: Shot[] = [{ name: "default", buf: await group.screenshot() }]
  const out = snapOutputPath("settings-models-fetch")
  await composeGrid(shots, out)
  process.stdout.write(`\n[snap] settings-models-fetch grid -> ${out}\n\n`)
})
