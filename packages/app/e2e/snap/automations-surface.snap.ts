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

  // Hover a row to reveal the one-click pause/resume action.
  await rows.first().hover()
  await surface.locator('[data-action="automation-toggle-active"]').first().waitFor({ state: "visible", timeout: 10_000 })
  const listHover = await page.screenshot()

  await rows.first().click()
  await surface.locator('[data-component="automation-detail"]').waitFor({ state: "visible", timeout: 30_000 })
  const detail = await page.screenshot()

  // Split entry: back to the list, open the New automation menu, screenshot it,
  // then Create manually, fill the card, and expand the schedule popover.
  await surface.locator('[data-action="automation-detail-back"]').click()
  await surface.locator('[data-action="automation-create-open"]').click()
  const manualItem = page.locator('[data-action="automation-create-manual"]')
  await manualItem.waitFor({ state: "visible", timeout: 10_000 })
  const createMenu = await page.screenshot()

  await manualItem.click()
  const card = page.locator('[data-component="automation-create"]')
  await card.waitFor({ state: "visible", timeout: 10_000 })
  await card.locator('[data-action="automation-create-title"]').fill("Release notes draft")
  await card.locator('[data-action="automation-create-prompt"]').fill("Draft release notes from PRs merged since the last tag.")
  const createCard = await page.screenshot()

  await card.locator('[data-action="automation-time"]').click()
  await page.locator('[data-action="automation-time-hour"]').first().waitFor({ state: "visible", timeout: 10_000 })
  const schedulePopover = await page.screenshot()

  const shots: Shot[] = [
    { name: "empty", buf: empty },
    { name: "list", buf: list },
    { name: "list-hover", buf: listHover },
    { name: "detail", buf: detail },
    { name: "create-menu", buf: createMenu },
    { name: "create-card", buf: createCard },
    { name: "schedule", buf: schedulePopover },
  ]
  const out = snapOutputPath("automations-surface")
  await composeGrid(shots, out)
  process.stdout.write(`\n[snap] automations-surface grid -> ${out}\n\n`)
})
