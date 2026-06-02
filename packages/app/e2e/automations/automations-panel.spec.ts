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
