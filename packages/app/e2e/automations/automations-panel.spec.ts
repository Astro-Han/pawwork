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

test("automations panel: schedule picker opens, selects, and layers escape", async ({ page, project }) => {
  test.setTimeout(120_000)

  await project.open()
  const surface = await openAutomations(page)

  await surface.locator('[data-action="automation-create-open"]').click()
  await page.locator('[data-action="automation-create-manual"]').click()

  const card = page.locator('[data-component="automation-create"]')
  await expect(card).toBeVisible()

  // The time token opens a UI Popover portalled to <body>. Inside the modal
  // dialog it must mount and stay — not flash shut as the focus scope hands off
  // from the dialog's trap (issue #950 PR7).
  await card.locator('[data-action="automation-time"]').click()
  const popover = page.locator('[data-component="popover-content"]')
  await expect(popover).toBeVisible()

  // The visible flash is a real-OS focus race that synthetic input can't trigger,
  // so assert the fix's mechanism instead. Shove focus back into the dialog (what
  // the modal Dialog's focus trap does on open): with a non-modal popover focus
  // escapes and stays on the title — the same outside-focus that, in the real
  // window, lets the dialog dismiss the picker (the #950 PR7 flash). The modal
  // popover traps focus back into itself, so it can never see an outside-focus
  // dismiss. The visible flash itself is verified manually in the Electron window.
  await card.locator('[data-action="automation-create-title"]').focus()
  await expect(popover).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-component="popover-content"]')))
    .toBe(true)

  // Picking a value works and never dismisses the parent dialog.
  await popover.locator('[data-action="automation-time-minute"][data-value="30"]').click()
  await expect(card.locator('[data-action="automation-time"]')).toContainText("09:30")
  await expect(popover).toBeVisible()
  await expect(card).toBeVisible()

  // Escape is layer-aware: the first press closes only the top-most popover and
  // the card stays; the second press closes the card. Guards against the shared
  // dialog stealing Escape from the picker layer.
  await page.keyboard.press("Escape")
  await expect(popover).toHaveCount(0)
  await expect(card).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(card).toHaveCount(0)
})

test("automations panel: model picker survives the dialog focus trap and reopens", async ({ page, project }) => {
  test.setTimeout(120_000)

  await project.open()
  const surface = await openAutomations(page)
  await surface.locator('[data-action="automation-create-open"]').click()
  await page.locator('[data-action="automation-create-manual"]').click()
  const card = page.locator('[data-component="automation-create"]')
  await expect(card).toBeVisible()

  const trigger = page.locator('[data-action="automation-model-trigger"]')
  const picker = page.locator("[data-picker-content]")

  // The model picker is the shared composer popover. Inside the modal dialog its
  // hand-rolled focus-outside dismiss used to fire when the dialog's focus trap
  // stole focus on open — flashing the picker shut, then wedging it permanently
  // closed because focus stayed trapped on the title (#950 PR7). Shoving focus
  // back into the dialog must NOT dismiss it.
  await trigger.click()
  await expect(picker).toBeVisible()
  await card.locator('[data-action="automation-create-title"]').focus()
  await expect(picker).toBeVisible()

  // Escape is layer-aware: it closes only the picker, the card stays.
  await page.keyboard.press("Escape")
  await expect(picker).toHaveCount(0)
  await expect(card).toBeVisible()

  // And it reopens — the wedged-shut state is gone.
  await trigger.click()
  await expect(picker).toBeVisible()
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
