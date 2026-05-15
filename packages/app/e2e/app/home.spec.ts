import { test, expect } from "../fixtures"
import { promptSelector, sessionComposerDockSelector } from "../selectors"

test("@smoke home renders the hero composer and starter cards", async ({ page, project }) => {
  await project.open()

  const home = page.locator('[data-component="session-new-home"]')
  const composer = home.locator(sessionComposerDockSelector)
  const firstCard = home.getByRole("button", { name: /Process docs/i })
  const workspaceChip = page.getByRole("button", { name: /Switch workspace|切换工作目录/i })
  await expect(home).toBeVisible()
  await expect(page.getByRole("heading", { name: "What do you want to do?" })).toBeVisible()
  await expect(page.locator(sessionComposerDockSelector)).toHaveCount(1)
  await expect(composer).toHaveCount(1)
  await expect(composer).toHaveCSS("text-align", "left")
  await expect(home.locator(promptSelector)).toBeVisible()
  await expect(firstCard).toBeVisible()
  await expect(page.getByRole("button", { name: /Analyze data/i })).toBeVisible()
  await expect(page.getByRole("button", { name: /Start writing/i })).toBeVisible()
  await expect(page.getByRole("button", { name: "Right utility panel" })).toBeVisible()
  await expect(workspaceChip).toBeVisible()

  const cardBox = await firstCard.boundingBox()
  const composerBox = await composer.boundingBox()
  expect(cardBox).not.toBeNull()
  expect(composerBox).not.toBeNull()
  expect(cardBox!.y).toBeGreaterThan(composerBox!.y)
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

test("@smoke home composer shows unified single-row bar with brand orange send", async ({ page, project }) => {
  await project.open()

  const home = page.locator('[data-component="session-new-home"]')
  const composer = home.locator(sessionComposerDockSelector)

  await expect(composer).toBeVisible()

  // no DockTray tray surface above the input
  await expect(composer.locator('[data-dock-surface="tray"]')).toHaveCount(0)

  // brand orange enables only when input has content, type first
  const prompt = home.locator(promptSelector)
  await prompt.click()
  await page.keyboard.type("x")

  const send = composer.locator('[data-action="prompt-submit"]')
  await expect(send).toBeVisible()
  await expect(send).toBeEnabled()

  // WorkspaceChip present on home
  const workspaceChip = page.getByRole("button", { name: /Switch workspace|切换工作目录/i })
  await expect(workspaceChip).toBeVisible()
})

test("home model chip keeps the single-row controls visible", async ({ page, project }) => {
  await project.open()

  const home = page.locator('[data-component="session-new-home"]')
  const composer = home.locator(sessionComposerDockSelector)
  const attach = composer.locator('[data-action="prompt-attach"]').first()
  const chip = composer.locator('[data-component="prompt-model-control"] [data-action="prompt-model"]').first()
  const workspace = composer.getByRole("button", { name: /Switch workspace|切换工作目录/i })
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

test("@smoke project home status panel can open the server picker dialog", async ({ page, project }) => {
  await project.open()

  const statusPanel = page.getByRole("complementary", { name: "Right utility panel" })
  if (!(await statusPanel.isVisible())) {
    await page.getByRole("button", { name: "Right utility panel" }).click()
  }
  await expect(statusPanel).toBeVisible()
  await statusPanel.getByRole("button", { name: "Manage servers" }).click()

  const dialog = page.getByRole("dialog")
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole("textbox").first()).toBeVisible()
})
