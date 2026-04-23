import { test, expect } from "../fixtures"
import { promptSelector, sessionComposerDockSelector } from "../selectors"

test("@smoke root route renders seeded home entrypoints", async ({ page }) => {
  await page.goto("/")

  const home = page.locator('[data-component="session-new-home"]')

  await expect(page.getByRole("button", { name: "Open project" }).first()).toBeVisible()
  await expect(page.getByRole("button", { name: "New session" })).toBeVisible()
  await expect(home).toBeVisible()
  await expect(page.getByRole("heading", { name: "Choose what to do" })).toBeVisible()
  await expect(home.locator(sessionComposerDockSelector)).toHaveCount(1)
  await expect(page.getByText("No recent projects")).toHaveCount(0)
  await expect(page.getByText("Get started by opening a local project")).toHaveCount(0)
})

test("@smoke home renders the hero composer and starter cards", async ({ page, project }) => {
  await project.open()

  const home = page.locator('[data-component="session-new-home"]')
  const composer = home.locator(sessionComposerDockSelector)
  const firstCard = home.getByRole("button", { name: /Process docs/i })
  const workspaceChip = page.getByRole("button", { name: /Switch workspace|切换工作目录/i })
  await expect(home).toBeVisible()
  await expect(page.getByRole("button", { name: "Open project" }).first()).toBeVisible()
  await expect(page.getByRole("heading", { name: "Choose what to do" })).toBeVisible()
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
  expect(cardBox!.y).toBeLessThan(composerBox!.y)
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
