import { test, expect } from "../fixtures"
import { openSettings } from "../actions"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

// Visual contract for the Settings > Models "Fetch models" action (issue #1463): a provider with model
// discovery shows a ghost button with the refresh icon in its header, above the model rows. Kimi uses
// the Anthropic adapter for inference, so this also guards the capability against SDK-based inference.
// Captured at rest — clicking would call the provider's live /models endpoint.
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

test("settings-models-fetch", async ({ page, project }) => {
  test.setTimeout(180_000)

  await project.open({
    beforeGoto: async ({ sdk }) => {
      await sdk.auth.set({
        providerID: "kimi-for-coding",
        auth: { type: "api", key: "snap-kimi-key" },
      })
    },
  })

  // App-shell toasts (e.g. server health checks) float over the page and bleed into block screenshots;
  // they are environment chrome, not the surface under test.
  await page.addStyleTag({ content: '[data-component="toast-region"] { display: none; }' })

  const settings = await openSettings(page)
  await settings.getByRole("tab", { name: "Models" }).click()

  const kimiHeading = settings.getByText("Kimi For Coding", { exact: true }).last()
  await expect(kimiHeading).toBeVisible({ timeout: 30_000 })
  const fetchButton = kimiHeading.locator("..").getByRole("button", { name: "Fetch models" })
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
