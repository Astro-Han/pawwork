import { test } from "../fixtures"
import { openSidebar } from "../actions"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

const recurring = (projectID: string, title: string, prompt: string, expression: string) => ({
  automationCreateInput: {
    kind: "recurring" as const,
    title,
    prompt,
    context: "fresh" as const,
    where: { projectID },
    timezone: "UTC",
    model: { providerID: "opencode", modelID: "big-pickle" },
    rhythm: { kind: "cron" as const, expression },
    stop: { kind: "never" as const },
  },
})

test("automations-surface", async ({ page, project }) => {
  test.setTimeout(180_000)

  await project.open()
  await openSidebar(page)

  await page.locator('[data-action="pawwork-automations-open"]').click()
  const surface = page.locator('[data-component="automations-page"]')
  await surface.waitFor({ state: "visible", timeout: 30_000 })
  await surface.locator('[data-component="automations-empty"]').waitFor({ state: "visible", timeout: 30_000 })
  const empty = await page.screenshot()

  // Seed via SDK; the live SSE event populates the list without a reload.
  const projectID = (await project.sdk.project.current()).data!.id
  await project.sdk.automation.create(recurring(projectID, "Daily standup digest", "Summarize overnight changes and list open PRs.", "0 9 * * *"))
  await project.sdk.automation.create(recurring(projectID, "Hourly build watch", "Check CI and flag a red main build.", "0 * * * *"))

  const rows = surface.locator('[data-action="automation-row"]')
  await rows.first().waitFor({ state: "visible", timeout: 30_000 })
  await page.waitForFunction(() => document.querySelectorAll('[data-action="automation-row"]').length >= 2)
  const list = await page.screenshot()

  await rows.first().click()
  await surface.locator('[data-component="automation-detail"]').waitFor({ state: "visible", timeout: 30_000 })
  const detail = await page.screenshot()

  const shots: Shot[] = [
    { name: "empty", buf: empty },
    { name: "list", buf: list },
    { name: "detail", buf: detail },
  ]
  const out = snapOutputPath("automations-surface")
  await composeGrid(shots, out)
  process.stdout.write(`\n[snap] automations-surface grid -> ${out}\n\n`)
})
