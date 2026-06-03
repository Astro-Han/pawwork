import { test, expect } from "../fixtures"
import { openSidebar } from "../actions"

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

test("@smoke automations panel: list, detail, pause, delete", async ({ page, project }) => {
  test.setTimeout(120_000)

  await project.open()
  await openSidebar(page)

  const toggle = page.locator('[data-action="pawwork-automations-open"]')
  await toggle.click()

  const surface = page.locator('[data-component="automations-page"]')
  await expect(surface).toBeVisible()
  await expect(surface.locator('[data-component="automations-empty"]')).toBeVisible()

  // Unlike the Settings takeover, opening Automations keeps the sidebar live: its
  // toggle stays mounted and pressed, and the settings nav never replaces it.
  await expect(toggle).toHaveAttribute("aria-pressed", "true")
  await expect(page.locator('[data-component="settings-nav"]')).toHaveCount(0)

  // Seed through the SDK; the live SSE event populates the list without a reload.
  const projectID = (await project.sdk.project.current()).data!.id
  await project.sdk.automation.create(
    recurring(projectID, "Daily standup digest", "Summarize overnight changes and list open PRs.", "0 9 * * *"),
  )

  const rows = surface.locator('[data-action="automation-row"]')
  await expect(rows).toHaveCount(1)

  await rows.first().click()
  const detail = surface.locator('[data-component="automation-detail"]')
  await expect(detail).toBeVisible()
  await expect(detail.getByRole("heading", { name: "Daily standup digest" })).toBeVisible()

  // Pause flips the icon-only action's aria-label to Resume and the status row to Paused.
  await detail.locator('[data-action="automation-toggle-active"]').click()
  await expect(detail.locator('[data-action="automation-toggle-active"]')).toHaveAttribute("aria-label", "Resume")
  await expect(detail.getByText("Paused")).toBeVisible()

  // Delete confirms through a dialog and drops back to the empty list.
  await detail.locator('[data-action="automation-delete"]').click()
  const dialog = page.locator('[data-component="dialog"]')
  await expect(dialog).toBeVisible()
  await dialog.locator('[data-action="automation-delete-confirm"]').click()

  await expect(surface.locator('[data-component="automations-empty"]')).toBeVisible()
  await expect(rows).toHaveCount(0)
})

async function openAutomations(page: Parameters<typeof openSidebar>[0]) {
  await openSidebar(page)
  await page.locator('[data-action="pawwork-automations-open"]').click()
  const surface = page.locator('[data-component="automations-page"]')
  await expect(surface).toBeVisible()
  return surface
}

test("automations panel: create manually adds an automation", async ({ page, project }) => {
  test.setTimeout(120_000)

  await project.open()
  const surface = await openAutomations(page)
  await expect(surface.locator('[data-component="automations-empty"]')).toBeVisible()

  // Split entry: open the New automation menu, then Create manually.
  await surface.locator('[data-action="automation-create-open"]').click()
  await page.locator('[data-action="automation-create-manual"]').click()

  const card = page.locator('[data-component="automation-create"]')
  await expect(card).toBeVisible()
  await card.locator('[data-action="automation-create-title"]').fill("Release notes draft")
  await card.locator('[data-action="automation-create-prompt"]').fill("Draft release notes from the latest merges.")
  // Model seeds from the last-used model, so Create is enabled with no extra step.
  await card.locator('[data-action="automation-create-submit"]').click()

  // Lands on the new automation's detail; it also shows up in the list.
  const detail = surface.locator('[data-component="automation-detail"]')
  await expect(detail).toBeVisible()
  await expect(detail.getByRole("heading", { name: "Release notes draft" })).toBeVisible()

  await detail.locator('[data-action="automation-detail-back"]').click()
  await expect(surface.locator('[data-action="automation-row"]')).toHaveCount(1)
})

test("automations panel: template prefills the create card", async ({ page, project }) => {
  test.setTimeout(120_000)

  await project.open()
  const surface = await openAutomations(page)
  const empty = surface.locator('[data-component="automations-empty"]')
  await expect(empty).toBeVisible()

  // Empty-state quick-starts open the create card pre-filled with the template.
  await empty.locator('[data-action="automation-template"]').first().click()
  const card = page.locator('[data-component="automation-create"]')
  await expect(card).toBeVisible()
  await expect(card.locator('[data-action="automation-create-title"]')).not.toHaveValue("")
  await expect(card.locator('[data-action="automation-create-prompt"]')).not.toHaveValue("")
})

test("automations panel: create via chat opens a prefilled session", async ({ page, project }) => {
  test.setTimeout(120_000)

  await project.open()
  const surface = await openAutomations(page)

  await surface.locator('[data-action="automation-create-open"]').click()
  await page.locator('[data-action="automation-create-chat"]').click()

  // Leaves the panel for a fresh session whose composer carries the guiding prompt.
  await expect(surface).toHaveCount(0)
  await expect(page.getByText("set up an automation", { exact: false })).toBeVisible()
})

test("automations panel: the automate tool card jumps into the panel", async ({ page, project, assistant }) => {
  test.setTimeout(120_000)

  await project.open()

  // The agent creates an automation in chat; the backend executes the tool for
  // real and echoes the resolved definition in the tool part metadata.
  await assistant.tool("automate", {
    title: "Nightly digest",
    prompt: "Summarize the day's changes every morning.",
    cron: "0 9 * * *",
  })
  await project.prompt("Set up a nightly digest automation.")

  const card = page.locator('[data-component="automate-tool-card"]')
  await expect(card).toBeVisible()
  await expect(card.getByText("Nightly digest")).toBeVisible()

  // The jump opens the Automations panel focused on the new automation.
  await card.locator('[data-component="automate-tool-action"]').click()
  const surface = page.locator('[data-component="automations-page"]')
  await expect(surface).toBeVisible()
  const detail = surface.locator('[data-component="automation-detail"]')
  await expect(detail).toBeVisible()
  await expect(detail.getByRole("heading", { name: "Nightly digest" })).toBeVisible()
})

test("automations panel: escape unwinds detail then closes the surface", async ({ page, project }) => {
  test.setTimeout(120_000)

  await project.open()
  await openSidebar(page)

  const toggle = page.locator('[data-action="pawwork-automations-open"]')
  await toggle.click()

  const surface = page.locator('[data-component="automations-page"]')
  await expect(surface).toBeVisible()

  const projectID = (await project.sdk.project.current()).data!.id
  await project.sdk.automation.create(
    recurring(projectID, "Hourly build watch", "Check CI and flag a red main build.", "0 * * * *"),
  )

  const rows = surface.locator('[data-action="automation-row"]')
  await expect(rows).toHaveCount(1)
  await rows.first().click()
  await expect(surface.locator('[data-component="automation-detail"]')).toBeVisible()

  // First Escape returns to the list, second Escape closes the surface entirely.
  await page.keyboard.press("Escape")
  await expect(surface.locator('[data-component="automation-detail"]')).toHaveCount(0)
  await expect(rows).toHaveCount(1)

  await page.keyboard.press("Escape")
  await expect(surface).toHaveCount(0)
  await expect(toggle).toHaveAttribute("aria-pressed", "false")
})
