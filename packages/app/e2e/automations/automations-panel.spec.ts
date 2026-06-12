import type { Page } from "@playwright/test"
import { getFilename } from "@opencode-ai/util/path"
import { test, expect } from "../fixtures"
import { cleanupTestProject, createTestProject, openSidebar } from "../actions"

type ModelKey = { providerID: string; modelID: string }

// Discover an e2e model that actually exposes thinking variants (most opencode
// mock models don't), via the composer probe, mirroring model-picker-thinking.
async function findVariantModel(page: Page): Promise<ModelKey | undefined> {
  const models = (await page.evaluate(() => {
    const win = window as Window & { __opencode_e2e?: { model?: { current?: { models?: Array<ModelKey & { name: string }> } } } }
    return win.__opencode_e2e?.model?.current?.models ?? []
  })) as Array<ModelKey & { name: string }>
  for (const model of models) {
    const variants = await page.evaluate((value) => {
      const win = window as Window & {
        __opencode_e2e?: {
          model?: { controls?: { setModel?: (v: ModelKey) => void }; current?: { variants?: string[] } }
        }
      }
      win.__opencode_e2e?.model?.controls?.setModel?.(value)
      return win.__opencode_e2e?.model?.current?.variants ?? []
    }, model)
    if (variants.length > 0) return model
  }
  return undefined
}

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

const oneshot = (projectID: string, title: string, prompt: string, fireAt: number) => ({
  automationCreateInput: {
    kind: "oneshot" as const,
    title,
    prompt,
    context: "fresh" as const,
    where: { projectID },
    timezone: "UTC",
    model: { providerID: "opencode", modelID: "big-pickle" },
    fireAt,
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

  // Unlike the Settings route, opening Automations keeps the sidebar live: its
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
  await expect(detail.locator('[data-action="automation-edit-title"]')).toHaveValue("Daily standup digest")

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

async function expectInternalHoverSurface(locator: ReturnType<Page["locator"]>) {
  await locator.hover()
  await expect
    .poll(async () =>
      locator.evaluate((element) => {
        const style = getComputedStyle(element)
        return {
          backgroundColor: style.backgroundColor,
          cursor: style.cursor,
          height: Math.round(element.getBoundingClientRect().height),
          textDecorationLine: style.textDecorationLine,
        }
      }),
    )
    .toMatchObject({
      cursor: "default",
      height: 30,
      textDecorationLine: "none",
    })
  await expect
    .poll(async () => locator.evaluate((element) => getComputedStyle(element).backgroundColor))
    .not.toBe("rgba(0, 0, 0, 0)")
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
  await expect(detail.locator('[data-action="automation-edit-title"]')).toHaveValue("Release notes draft")

  await detail.locator('[data-action="automation-detail-back"]').click()
  await expect(surface.locator('[data-action="automation-row"]')).toHaveCount(1)
})

test("automations panel: lists automations from every open project", async ({ page, project, backend }) => {
  test.setTimeout(120_000)

  const other = await createTestProject({ serverUrl: backend.url })
  try {
    await project.open({ extra: [other] })

    const otherSDK = backend.sdk(other)
    const otherProjectID = (await otherSDK.project.current()).data!.id
    const otherProjectName = "External Automation Project"
    await otherSDK.project.update({ projectID: otherProjectID, name: otherProjectName })
    const created = (await otherSDK.automation.create(
      recurring(otherProjectID, "Cross-project digest", "Summarize the other project.", "0 9 * * 1-5"),
    )).data!

    const surface = await openAutomations(page)
    const rows = surface.locator('[data-action="automation-row"]')
    await expect(rows).toHaveCount(1)
    const row = rows.first()
    await expect(row).toContainText("Cross-project digest")
    await expect(row).toContainText(otherProjectName)
    await expect(row).not.toContainText(getFilename(other))

    await surface.locator(`[data-action="automation-toggle-active"][data-automation-id="${created.id}"]`).click({ force: true })
    await expect
      .poll(async () => {
        const items = (await otherSDK.automation.list()).data?.items ?? []
        return items.find((automation) => automation.id === created.id)?.paused ?? false
      })
      .toBe(true)

    // Opening detail loads the run history once. Toggling pause/resume updates
    // the definition, but should not reload runs unless the shown automation
    // identity changes.
    let runListRequests = 0
    page.on("request", (request) => {
      if (request.url().includes(`/automation/${created.id}/runs`)) runListRequests++
    })

    await row.click()
    const detail = surface.locator('[data-component="automation-detail"]')
    await expect(detail.locator('[data-action="automation-edit-title"]')).toHaveValue("Cross-project digest")
    await expect(detail.getByText(otherProjectName)).toBeVisible()
    await expect(detail.getByText("Paused")).toBeVisible()
    await expect.poll(() => runListRequests).toBe(1)

    await detail.locator('[data-action="automation-toggle-active"]').click()
    await expect
      .poll(async () => {
        const items = (await otherSDK.automation.list()).data?.items ?? []
        return items.find((automation) => automation.id === created.id)?.paused ?? true
      })
      .toBe(false)
    await page.waitForTimeout(250)
    expect(runListRequests).toBe(1)
  } finally {
    await cleanupTestProject(other, { serverUrl: backend.url })
  }
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

test("automations panel: thinking submenu stays open inside the modal create card", async ({ page, project }) => {
  test.setTimeout(120_000)

  await project.open()

  // The thinking submenu only renders for models that expose variants; discover
  // one via the composer probe before navigating to the panel.
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const win = window as Window & { __opencode_e2e?: { model?: { current?: { models?: unknown[] } } } }
          return win.__opencode_e2e?.model?.current?.models?.length ?? 0
        }),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0)
  const model = await findVariantModel(page)
  test.skip(!model, "no e2e model with thinking variants")
  if (!model) return

  const surface = await openAutomations(page)
  await surface.locator('[data-action="automation-create-open"]').click()
  await page.locator('[data-action="automation-create-manual"]').click()
  const card = page.locator('[data-component="automation-create"]')
  await expect(card).toBeVisible()

  // Select the variant-capable model so the thinking trigger is enabled.
  await page.locator('[data-action="automation-model-trigger"]').click()
  const picker = page.locator("[data-picker-content]")
  await expect(picker).toBeVisible()
  await picker
    .locator(`[data-slot="list-item"][data-key="${model.providerID}:${model.modelID}"]`)
    .first()
    .click({ force: true })

  // Reopen the picker and open the thinking submenu.
  await page.locator('[data-action="automation-model-trigger"]').click()
  const thinkingTrigger = page.locator('[data-action="prompt-model-thinking-trigger"]').first()
  await expect(thinkingTrigger).toBeVisible()
  await expect(thinkingTrigger).toBeEnabled()
  await thinkingTrigger.click()

  // The nested thinking popover is non-modal; inside the modal outer picker the
  // outer's focus trap used to steal focus the instant the submenu autofocused,
  // flashing it shut (#950 PR7). A single auto-retrying toBeVisible can catch the
  // brief open frame and pass anyway, so sample the option count over time and
  // assert it is still open after the focus hand-off would have fired.
  const option = page.locator('[data-action="prompt-model-thinking-option"]').first()
  await expect(option).toBeVisible()
  await expect
    .poll(() => page.locator('[data-action="prompt-model-thinking-option"]').count(), { timeout: 2_000 })
    .toBeGreaterThan(0)
  await page.waitForTimeout(300)
  await expect(option).toBeVisible()

  // And it is usable: picking a non-default level applies the selection (the
  // option marks itself selected) without tearing down the outer picker or card.
  const level = page.locator('[data-action="prompt-model-thinking-option"]').nth(1)
  await level.click()
  await expect(level).toHaveAttribute("data-selected", "")
  await expect(card).toBeVisible()
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
  // The card names the session mode. A model-created automation defaults to
  // fresh here (continue rides on the automate tool's continueSession field,
  // which would instead loop the runs inside this conversation).
  await expect(card.locator('[data-component="automate-tool-session"]')).toHaveText("New session each run")

  // The jump opens the Automations panel focused on the new automation.
  await card.locator('[data-component="automate-tool-action"]').click()
  const surface = page.locator('[data-component="automations-page"]')
  await expect(surface).toBeVisible()
  const detail = surface.locator('[data-component="automation-detail"]')
  await expect(detail).toBeVisible()
  await expect(detail.locator('[data-action="automation-edit-title"]')).toHaveValue("Nightly digest")
})

test("automations panel: a second tool card jump opens its own automation", async ({ page, project, assistant }) => {
  test.setTimeout(120_000)

  await project.open()

  // First card → panel focused on Alpha.
  await assistant.tool("automate", { title: "Alpha digest", prompt: "Summarize A.", cron: "0 9 * * *" })
  await project.prompt("Set up alpha.")
  const cardA = page.locator('[data-component="automate-tool-card"]').filter({ hasText: "Alpha digest" })
  await expect(cardA).toBeVisible()
  await cardA.locator('[data-component="automate-tool-action"]').click()
  const surface = page.locator('[data-component="automations-page"]')
  const detail = surface.locator('[data-component="automation-detail"]')
  await expect(detail.locator('[data-action="automation-edit-title"]')).toHaveValue("Alpha digest")

  // Close the panel (the surface takes over main, so the chat — and the next
  // tool card — is only reachable once it's closed), then jump from a second
  // card. The surface is <Show>-gated, so it remounts and must focus Bravo, not
  // re-show the stale Alpha selection.
  await page.keyboard.press("Escape")
  await page.keyboard.press("Escape")
  await expect(surface).toHaveCount(0)

  await assistant.tool("automate", { title: "Bravo digest", prompt: "Summarize B.", cron: "0 10 * * *" })
  await project.prompt("Set up bravo.")
  const cardB = page.locator('[data-component="automate-tool-card"]').filter({ hasText: "Bravo digest" })
  await expect(cardB).toBeVisible()
  await cardB.locator('[data-component="automate-tool-action"]').click()
  await expect(detail.locator('[data-action="automation-edit-title"]')).toHaveValue("Bravo digest")
})

test("automations panel: a pending one-shot shows its next run time", async ({ page, project }) => {
  test.setTimeout(120_000)

  await project.open()
  const surface = await openAutomations(page)

  // A day out so the scheduler leaves it pending. One-shots used to hide the next
  // run entirely (only recurring surfaced it), so the detail showed no fire time.
  const projectID = (await project.sdk.project.current()).data!.id
  const fireAt = Date.now() + 24 * 60 * 60 * 1000
  await project.sdk.automation.create(oneshot(projectID, "Rehearsal reminder", "Remind me to rehearse the duet.", fireAt))

  const rows = surface.locator('[data-action="automation-row"]')
  await expect(rows).toHaveCount(1)
  await rows.first().click()

  const detail = surface.locator('[data-component="automation-detail"]')
  await expect(detail).toBeVisible()
  // It reads as a one-shot, yet still surfaces a Next run row before any run.
  await expect(detail.getByText("Once")).toBeVisible()
  await expect(detail.getByText("Next run")).toBeVisible()
  // The value must be fireAt formatted in the automation's UTC timezone, not just
  // a present row: compute the expectation with the same Intl call the component
  // uses, so a wrong timezone or a broken formatter regresses this assertion.
  const expected = await page.evaluate(
    (ms) =>
      new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "UTC",
      }).format(new Date(ms)),
    fireAt,
  )
  await expect(detail.getByText(expected)).toBeVisible()
})

test("automations panel: a manual run before fireAt keeps the one-shot's next run", async ({ page, project }) => {
  test.setTimeout(120_000)

  await project.open()
  const surface = await openAutomations(page)

  // Scheduled a day out; a manual Run now fires a run at "now", before fireAt.
  // The scheduler only treats a one-shot as spent once a run lands at/after
  // fireAt, so this early run must NOT hide the still-pending next run.
  const projectID = (await project.sdk.project.current()).data!.id
  const fireAt = Date.now() + 24 * 60 * 60 * 1000
  await project.sdk.automation.create(oneshot(projectID, "Dress rehearsal", "Run the dress rehearsal.", fireAt))

  const rows = surface.locator('[data-action="automation-row"]')
  await expect(rows).toHaveCount(1)
  await rows.first().click()

  const detail = surface.locator('[data-component="automation-detail"]')
  await expect(detail).toBeVisible()
  await expect(detail.getByText("Next run")).toBeVisible()

  // Fire it manually, then wait for the run to land (the Last run row appears).
  await detail.locator('[data-action="automation-run-now"]').click()
  await expect(detail.getByText("Last run")).toBeVisible()
  // The early run's triggeredAt is before fireAt, so the next run still stands.
  await expect(detail.getByText("Next run")).toBeVisible()
})

test("automations panel: detail edits title, prompt, schedule and model inline", async ({ page, project }) => {
  test.setTimeout(120_000)

  await project.open()
  const surface = await openAutomations(page)

  const projectID = (await project.sdk.project.current()).data!.id
  const created = (
    await project.sdk.automation.create(
      recurring(projectID, "Daily digest", "Summarize the day's changes.", "0 9 * * *"),
    )
  ).data!

  const rows = surface.locator('[data-action="automation-row"]')
  await expect(rows).toHaveCount(1)
  await rows.first().click()
  const detail = surface.locator('[data-component="automation-detail"]')
  await expect(detail).toBeVisible()

  const automation = async () =>
    (await project.sdk.automation.list()).data!.items.find((item) => item.id === created.id)!

  // Title: type and blur commits; Escape while editing only blurs, it must not
  // unwind back to the list.
  const title = detail.locator('[data-action="automation-edit-title"]')
  await title.fill("Daily digest v2")
  await page.keyboard.press("Escape")
  await expect(detail).toBeVisible()
  await expect(title).toHaveValue("Daily digest")
  await title.fill("Daily digest v2")
  await page.keyboard.press("Enter")
  await expect.poll(async () => (await automation()).title).toBe("Daily digest v2")

  // Prompt: blur commits.
  const prompt = detail.locator('[data-action="automation-edit-prompt"]')
  await prompt.fill("Summarize the day's changes and open PRs.")
  await prompt.blur()
  await expect.poll(async () => (await automation()).prompt).toBe("Summarize the day's changes and open PRs.")

  // Schedule: the Repeats row opens the schedule popover. A recurring
  // automation must not offer the one-shot frequency, and picking Weekdays
  // rewrites the cron in place.
  await detail.locator('[data-action="automation-edit-schedule"]').click()
  const popover = page.locator('[data-component="popover-content"]')
  await expect(popover).toBeVisible()
  await expect(popover.locator('[data-frequency="once"]')).toHaveCount(0)
  await popover.locator('[data-frequency="weekdays"]').click()
  await expect
    .poll(async () => {
      const definition = await automation()
      return definition.kind === "recurring" && definition.rhythm.kind === "cron" ? definition.rhythm.expression : ""
    })
    .toBe("0 9 * * 1-5")
  await page.keyboard.press("Escape")
  await expect(detail).toBeVisible()

  // Model: the Model row opens the shared picker; choosing an entry patches the
  // definition to that model.
  await detail.locator('[data-action="automation-edit-model"]').click()
  const picker = page.locator("[data-picker-content]")
  await expect(picker).toBeVisible()
  const target = picker.locator('[data-slot="list-item"][data-key]').last()
  const key = (await target.getAttribute("data-key"))!
  await target.click({ force: true })
  await expect
    .poll(async () => {
      const definition = await automation()
      return `${definition.model.providerID}:${definition.model.modelID}`
    })
    .toBe(key)
})

test("automations panel: detail moves an automation to another open project", async ({ page, project, backend }) => {
  test.setTimeout(120_000)

  const other = await createTestProject({ serverUrl: backend.url })
  try {
    await project.open({ extra: [other] })

    const otherSDK = backend.sdk(other)
    const otherProjectID = (await otherSDK.project.current()).data!.id
    await otherSDK.project.update({ projectID: otherProjectID, name: "Move Target Project" })

    const projectID = (await project.sdk.project.current()).data!.id
    const created = (
      await project.sdk.automation.create(
        recurring(projectID, "Migrating digest", "Summarize for the new home.", "0 9 * * *"),
      )
    ).data!

    const surface = await openAutomations(page)
    const rows = surface.locator('[data-action="automation-row"]')
    await rows.filter({ hasText: "Migrating digest" }).first().click()
    const detail = surface.locator('[data-component="automation-detail"]')
    await expect(detail).toBeVisible()

    // The Project row is a picker when another project is open. Moving updates
    // the same automation in place: it appears in the target project's list,
    // vanishes from the source, and the detail stays open on the same id.
    await detail.locator('[data-action="automation-edit-project"]').click()
    await page.locator(`[data-project="${otherProjectID}"]`).click()

    await expect
      .poll(async () => ((await otherSDK.automation.list()).data?.items ?? []).find((item) => item.id === created.id))
      .toMatchObject({ id: created.id, title: "Migrating digest" })
    await expect
      .poll(async () =>
        ((await project.sdk.automation.list()).data?.items ?? []).filter((item) => item.id === created.id).length,
      )
      .toBe(0)
    await expect(detail.locator('[data-action="automation-edit-title"]')).toHaveValue("Migrating digest")
    await expect(detail.getByText("Move Target Project")).toBeVisible()
  } finally {
    await cleanupTestProject(other, { serverUrl: backend.url })
  }
})

test("automations panel: detail project picker stays available with one open project", async ({ page, project }) => {
  test.setTimeout(120_000)

  await project.open()

  const projectID = (await project.sdk.project.current()).data!.id
  await project.sdk.automation.create(
    recurring(projectID, "Single project digest", "Summarize the current project.", "0 9 * * *"),
  )

  const surface = await openAutomations(page)
  await surface.locator('[data-action="automation-row"]', { hasText: "Single project digest" }).first().click()

  const detail = surface.locator('[data-component="automation-detail"]')
  await expect(detail).toBeVisible()

  const projectPicker = detail.locator('[data-action="automation-edit-project"]')
  await expect(projectPicker).toBeVisible()

  await expectInternalHoverSurface(projectPicker)
  await expectInternalHoverSurface(detail.locator('[data-action="automation-edit-schedule"]'))
  await expectInternalHoverSurface(detail.locator('[data-action="automation-edit-model"]'))

  await projectPicker.click()
  const menu = page.locator('[role="menu"][aria-label="Workspace"]')
  await expect(menu).toBeVisible()
  await expect(menu.locator(`[data-project="${projectID}"]`)).toBeVisible()
  await menu.locator('[data-action="automation-folder-open-project"]').click()
  await expect(menu).toBeHidden()
  const directoryDialog = page.getByRole("dialog").filter({ has: page.getByPlaceholder("Search folders") })
  await expect(directoryDialog).toBeVisible()
  await expect(surface).toBeVisible()
  expect(new URL(page.url()).pathname).toBe("/automations")
})

test("automations panel: continue automation project stays read-only", async ({ page, project, assistant }) => {
  test.setTimeout(120_000)

  await project.open()
  await assistant.tool("automate", {
    title: "Continue project loop",
    prompt: "Keep checking the same conversation.",
    cron: "0 8 * * *",
    continueSession: true,
  })
  await project.prompt("Loop this conversation every morning.")

  const surface = await openAutomations(page)
  await surface.locator('[data-action="automation-row"]', { hasText: "Continue project loop" }).first().click()

  const detail = surface.locator('[data-component="automation-detail"]')
  await expect(detail).toBeVisible()
  await expect(detail.locator('[data-action="automation-edit-project"]')).toHaveCount(0)
  await expectInternalHoverSurface(detail.locator('[data-action="automation-open-source"]'))
})

test("automations panel: a rhythm the picker cannot express is read-only", async ({ page, project }) => {
  test.setTimeout(120_000)

  await project.open()
  const surface = await openAutomations(page)

  // Hourly cron is real (SDK/automate tool) but outside the picker's four
  // frequencies. Offering the editor would pre-select a frequency the
  // definition does not have and silently rewrite the cron on any knob change,
  // so the Repeats row must render as plain text with no trigger at all.
  const projectID = (await project.sdk.project.current()).data!.id
  await project.sdk.automation.create(
    recurring(projectID, "Hourly build watch", "Check CI and flag a red main build.", "0 * * * *"),
  )

  const rows = surface.locator('[data-action="automation-row"]')
  await expect(rows).toHaveCount(1)
  await rows.first().click()

  const detail = surface.locator('[data-component="automation-detail"]')
  await expect(detail).toBeVisible()
  await expect(detail.getByText("Hourly")).toBeVisible()
  await expect(detail.locator('[data-action="automation-edit-schedule"]')).toHaveCount(0)
})

test("automations panel: a paused automation arrives paused after a move", async ({ page, project, backend }) => {
  test.setTimeout(120_000)

  const other = await createTestProject({ serverUrl: backend.url })
  try {
    await project.open({ extra: [other] })
    const otherSDK = backend.sdk(other)
    const otherProjectID = (await otherSDK.project.current()).data!.id

    const projectID = (await project.sdk.project.current()).data!.id
    const created = (
      await project.sdk.automation.create(
        recurring(projectID, "Silenced digest", "Stay quiet until resumed.", "0 9 * * *"),
      )
    ).data!
    await project.sdk.automation.pause({ automationID: created.id })

    const surface = await openAutomations(page)
    await surface.locator('[data-action="automation-row"]').filter({ hasText: "Silenced digest" }).first().click()
    const detail = surface.locator('[data-component="automation-detail"]')
    await expect(detail).toBeVisible()

    await detail.locator('[data-action="automation-edit-project"]').click()
    await page.locator(`[data-project="${otherProjectID}"]`).click()

    // The moved definition must keep the silence the user set, not wake up live.
    await expect
      .poll(async () => {
        const moved = ((await otherSDK.automation.list()).data?.items ?? []).find((item) => item.id === created.id)
        return moved ? moved.paused : "missing"
      })
      .toBe(true)
    await expect
      .poll(async () => ((await project.sdk.automation.list()).data?.items ?? []).length)
      .toBe(0)
  } finally {
    await cleanupTestProject(other, { serverUrl: backend.url })
  }
})

test("automations panel: a failed move keeps the source", async ({
  page,
  project,
  backend,
}) => {
  test.setTimeout(120_000)

  const other = await createTestProject({ serverUrl: backend.url })
  try {
    await project.open({ extra: [other] })
    const otherSDK = backend.sdk(other)
    const otherProjectID = (await otherSDK.project.current()).data!.id

    const projectID = (await project.sdk.project.current()).data!.id
    const created = (
      await project.sdk.automation.create(
        recurring(projectID, "Silenced digest", "Stay quiet until resumed.", "0 9 * * *"),
      )
    ).data!
    await project.sdk.automation.pause({ automationID: created.id })

    const surface = await openAutomations(page)
    await surface.locator('[data-action="automation-row"]').filter({ hasText: "Silenced digest" }).first().click()
    const detail = surface.locator('[data-component="automation-detail"]')
    await expect(detail).toBeVisible()

    await page.route(`**/automation/${created.id}`, (route) => {
      if (route.request().method() !== "PUT") return route.continue()
      return route.fulfill({ status: 500, body: "{}" })
    })
    await detail.locator('[data-action="automation-edit-project"]').click()
    await page.locator(`[data-project="${otherProjectID}"]`).click()

    await expect(page.locator('[data-component="toast"]')).toBeVisible()
    await expect
      .poll(async () => ((await otherSDK.automation.list()).data?.items ?? []).length)
      .toBe(0)
    await expect
      .poll(async () => {
        const source = ((await project.sdk.automation.list()).data?.items ?? []).find((item) => item.id === created.id)
        return source ? source.paused : "gone"
      })
      .toBe(true)
  } finally {
    await cleanupTestProject(other, { serverUrl: backend.url })
  }
})

test("automations panel: list rows expose run, pause and delete on hover", async ({ page, project }) => {
  test.setTimeout(120_000)

  await project.open()
  const surface = await openAutomations(page)

  const projectID = (await project.sdk.project.current()).data!.id
  const created = (
    await project.sdk.automation.create(
      recurring(projectID, "Hourly check", "Check the build.", "0 * * * *"),
    )
  ).data!

  const rows = surface.locator('[data-action="automation-row"]')
  await expect(rows).toHaveCount(1)

  // Keyboard path: focusing the row alone must already reveal the actions —
  // a keyboard user should not face a blank slot where the summary just hid.
  await rows.first().focus()
  await expect(surface.locator('[data-component="automation-row-actions"]')).toHaveCSS("opacity", "1")

  await rows.first().hover()

  // Run now fires a run without leaving the list.
  await surface.locator(`[data-action="automation-run-now"][data-automation-id="${created.id}"]`).click()
  await expect
    .poll(async () => ((await project.sdk.automation.runs({ automationID: created.id })).data?.items ?? []).length)
    .toBeGreaterThan(0)

  // Pause flips the toggle to Resume in place.
  const toggle = surface.locator(`[data-action="automation-toggle-active"][data-automation-id="${created.id}"]`)
  await toggle.click()
  await expect(toggle).toHaveAttribute("aria-label", "Resume")
  await expect
    .poll(async () => (await project.sdk.automation.list()).data!.items.find((item) => item.id === created.id)?.paused)
    .toBe(true)

  // Delete confirms through the shared dialog and empties the list.
  await rows.first().hover()
  await surface.locator(`[data-action="automation-delete"][data-automation-id="${created.id}"]`).click()
  const dialog = page.locator('[data-component="dialog"]')
  await expect(dialog).toBeVisible()
  await dialog.locator('[data-action="automation-delete-confirm"]').click()
  await expect(rows).toHaveCount(0)
  await expect(surface.locator('[data-component="automations-empty"]')).toBeVisible()
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
