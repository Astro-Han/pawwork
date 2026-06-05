import { test, expect } from "../fixtures"
import { openSettings } from "../actions"
import { promptSelector, sessionComposerDockSelector } from "../selectors"

test("@smoke home renders hero composer with updated welcome heading", async ({ page, project }) => {
  await project.open()

  const home = page.locator('[data-component="session-new-home"]')
  const composer = home.locator(sessionComposerDockSelector)
  const workspaceChip = page.getByRole("button", { name: /Choose workspace|选择工作目录/i })
  await expect(home).toBeVisible()
  await expect(page.getByRole("heading", { name: /今天我们做点什么|What should we work on/ })).toBeVisible()
  await expect(page.locator(sessionComposerDockSelector)).toHaveCount(1)
  await expect(composer).toHaveCount(1)
  await expect(composer).toHaveCSS("text-align", "left")
  await expect(home.locator(promptSelector)).toBeVisible()
  await expect(page.getByRole("button", { name: "Right utility panel" })).toBeVisible()
  await expect(workspaceChip).toBeVisible()

  // Skill-card shortcuts removed in #603 PR2 — slash commands typed directly in
  // the composer remain available for the same productivity skills.
  await expect(home.getByRole("button", { name: /Process docs/i })).toHaveCount(0)
  await expect(home.getByRole("button", { name: /Analyze data/i })).toHaveCount(0)
  await expect(home.getByRole("button", { name: /Start writing/i })).toHaveCount(0)
})

test("@smoke home hero prompt starts a session", async ({ page, project, assistant }) => {
  await project.open()

  const home = page.locator('[data-component="session-new-home"]')
  const prompt = home.locator(sessionComposerDockSelector).locator(promptSelector)
  await expect(prompt).toBeVisible()
  await assistant.reply("home hero reply")
  await page.keyboard.type("Use the home hero prompt")
  await page.keyboard.press("Enter")

  await expect.poll(() => page.url(), { timeout: 30_000 }).toContain("/session/")
  await expect(page.locator(sessionComposerDockSelector)).toHaveCount(1)
  await expect(page.locator(promptSelector)).toHaveCount(1)
  await expect(page.getByText("home hero reply")).toBeVisible()
})

test("@smoke home composer submits a slash-prefixed prompt via the fallback path", async ({
  page,
  project,
  assistant,
}) => {
  // Guards the #603 PR2 simplification of submit.ts: removing the `!homeSkill`
  // gate must not break the slash-prefix fall-through. A leading `/` that does
  // not match a registered command should still fall through to the standard
  // prompt path. Using an unregistered command name keeps the test independent
  // of which backend slash commands are bundled in the fixture.
  await project.open()

  const home = page.locator('[data-component="session-new-home"]')
  const prompt = home.locator(sessionComposerDockSelector).locator(promptSelector)
  await expect(prompt).toBeVisible()
  await assistant.reply("slash hero reply")
  await page.keyboard.type("/pr2skillcheck verify slash submit")
  await page.keyboard.press("Enter")

  await expect.poll(() => page.url(), { timeout: 30_000 }).toContain("/session/")
  await expect(page.getByText("slash hero reply")).toBeVisible()
})

test("@smoke home composer shows unified single-row bar with brand orange send", async ({ page, project }) => {
  await project.open()

  const home = page.locator('[data-component="session-new-home"]')
  const composer = home.locator(sessionComposerDockSelector)

  await expect(composer).toBeVisible()

  // no DockTray tray surface above the input
  await expect(composer.locator('[data-dock-surface="tray"]')).toHaveCount(0)

  const prompt = home.locator(promptSelector)
  const send = composer.locator('[data-action="prompt-submit"]')

  // send is disabled while the prompt is blank — guards the readiness rule
  // that #603 PR2 simplified after removing the selectedSkill bypass.
  await expect(send).toBeVisible()
  await expect(send).toBeDisabled()

  // brand orange enables only when input has content
  await prompt.click()
  await page.keyboard.type("x")
  await expect(send).toBeEnabled()

  // clearing the prompt returns send to disabled
  await page.keyboard.press("Backspace")
  await expect(send).toBeDisabled()

  // WorkspaceChip present on home
  const workspaceChip = page.getByRole("button", { name: /Choose workspace|选择工作目录/i })
  await expect(workspaceChip).toBeVisible()
})

test("home model chip keeps the single-row controls visible", async ({ page, project }) => {
  await project.open()

  const home = page.locator('[data-component="session-new-home"]')
  const composer = home.locator(sessionComposerDockSelector)
  const attach = composer.locator('[data-action="prompt-attach"]').first()
  const chip = composer.locator('[data-component="prompt-model-control"] [data-action="prompt-model"]').first()
  const workspace = composer.getByRole("button", { name: /Choose workspace|选择工作目录/i })
  const send = composer.locator('[data-action="prompt-submit"]').first()

  await expect(chip).toBeVisible()

  // Guard the single-row chip bar contract without pinning the model chip to
  // an obsolete fixed width.
  const composerBox = await composer.boundingBox()
  expect(composerBox).not.toBeNull()

  for (const control of [attach, chip, workspace, send]) {
    await expect(control).toBeVisible()
    const controlBox = await control.boundingBox()

    expect(controlBox).not.toBeNull()
    expect(controlBox!.width).toBeGreaterThan(0)
    expect(controlBox!.x).toBeGreaterThanOrEqual(composerBox!.x)
    expect(controlBox!.x + controlBox!.width).toBeLessThanOrEqual(composerBox!.x + composerBox!.width)
    expect(controlBox!.y).toBeGreaterThanOrEqual(composerBox!.y)
    expect(controlBox!.y + controlBox!.height).toBeLessThanOrEqual(composerBox!.y + composerBox!.height)
  }
})

test("@smoke settings integrations can open the server picker dialog", async ({ page, project }) => {
  await project.open()

  const settings = await openSettings(page)
  await settings.getByRole("tab", { name: "Integrations" }).click()
  await settings.locator('[data-component="settings-integrations"]').waitFor({ state: "visible" })
  await settings.getByRole("button", { name: "Manage servers" }).click()

  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole("textbox").first()).toBeVisible()
})
