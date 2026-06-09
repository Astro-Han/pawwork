import { test } from "../fixtures"
import { openSidebar } from "../actions"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

// The public HTTP create can only mint fresh automations; a continue one is
// born from a chat through the automate tool (see the seed below), so this
// SDK helper is fresh-only.
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

test("automations-surface", async ({ page, project, assistant }) => {
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

  // A continue automation can only be born from a chat: it loops inside the
  // conversation it was created in, so the public HTTP create now rejects a
  // source-less continue. Seed it through the real automate tool instead. The
  // surface takes over the main area and hides the composer, so close it first
  // (Escape), let the mock model emit the tool call, and have the backend run
  // it for real, binding the source to this conversation as a user would.
  await page.keyboard.press("Escape")
  await surface.waitFor({ state: "detached", timeout: 10_000 })
  await assistant.tool("automate", {
    title: "Inbox triage loop",
    prompt: "Pick up triage where the last run left off.",
    cron: "0 8 * * *",
    continueSession: true,
  })
  await project.prompt("Loop my inbox triage every morning.")

  // Re-open the surface; all three automations are now in the synced store.
  await openSidebar(page)
  await page.locator('[data-action="pawwork-automations-open"]').click()
  await surface.waitFor({ state: "visible", timeout: 30_000 })

  const rows = surface.locator('[data-action="automation-row"]')
  await rows.first().waitFor({ state: "visible", timeout: 30_000 })
  await page.waitForFunction(() => document.querySelectorAll('[data-action="automation-row"]').length >= 3)
  const list = await page.screenshot()

  // Hover a row to reveal the one-click pause/resume action.
  await rows.first().hover()
  await surface.locator('[data-action="automation-toggle-active"]').first().waitFor({ state: "visible", timeout: 10_000 })
  const listHover = await page.screenshot()

  // Open a detail by title (row order is not load-stable once a third seed is
  // added), screenshot, then return to the list.
  const openDetail = async (title: string) => {
    await surface.locator('[data-action="automation-row"]', { hasText: title }).first().click()
    await surface.locator('[data-component="automation-detail"]').waitFor({ state: "visible", timeout: 30_000 })
    const shot = await page.screenshot()
    await surface.locator('[data-action="automation-detail-back"]').click()
    await rows.first().waitFor({ state: "visible", timeout: 10_000 })
    return shot
  }
  const detail = await openDetail("Daily standup digest")
  const detailContinue = await openDetail("Inbox triage loop")

  // Split entry: open the New automation menu, screenshot it, then Create
  // manually, fill the card, and expand the schedule popover.
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
    { name: "detail-continue", buf: detailContinue },
    { name: "create-menu", buf: createMenu },
    { name: "create-card", buf: createCard },
    { name: "schedule", buf: schedulePopover },
  ]
  const out = snapOutputPath("automations-surface")
  await composeGrid(shots, out)
  process.stdout.write(`\n[snap] automations-surface grid -> ${out}\n\n`)
})
