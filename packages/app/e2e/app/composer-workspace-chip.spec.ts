import { expect, test } from "../fixtures"
import { createTestProject, withSession } from "../actions"
import { promptSelector } from "../selectors"
import { dirSlug } from "../utils"
import path from "node:path"

test("workspace chip popover opens on click", async ({ page, project }) => {
  await project.open()
  const chip = page.locator('[data-action="prompt-workspace"]')
  await chip.click()

  const popover = page.getByRole("menu")
  await expect(popover).toBeVisible()

  const firstItem = popover.getByRole("menuitemradio").first()
  await expect(firstItem).toBeVisible()
})

test("active workspace has a check icon", async ({ page, project }) => {
  await project.open()
  const chip = page.locator('[data-action="prompt-workspace"]')
  await chip.click()

  const popover = page.getByRole("menu")
  const active = popover.getByRole("menuitemradio", { checked: true })
  await expect(active).toHaveCount(1)
})

test("homepage draft stays visible while workspace chip changes the send target", async ({ page, project, backend, assistant }) => {
  const other = await createTestProject({ serverUrl: backend.url })
  await project.open({ extra: [other] })
  project.trackDirectory(other)

  const draft = `https://x.com/paulg/status/${Date.now()}`
  const prompt = page.locator(promptSelector).first()
  await prompt.click()
  await page.keyboard.type(draft)
  await expect.poll(async () => (await prompt.textContent())?.replace(/\u200B/g, "").trim()).toBe(draft)

  await page.locator('[data-action="prompt-workspace"]').click()
  await page.getByRole("menuitemradio", { name: path.basename(other) }).click()
  await expect(page).toHaveURL(new RegExp(`/${dirSlug(other)}/session`))
  await expect.poll(async () => (await prompt.textContent())?.replace(/\u200B/g, "").trim()).toBe(draft)

  await assistant.reply("ok")
  await page.getByRole("button", { name: "Send" }).first().click()
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const sent = (window as any).__opencode_e2e?.prompt?.sent
          return sent?.directory
        }),
      { timeout: 90_000 },
    )
    .toBe(other)

  const sessionID = await page.evaluate(() => (window as any).__opencode_e2e?.prompt?.sent?.sessionID)
  if (sessionID) project.trackSession(sessionID, other)
})

test("workspace chip hidden in session", async ({ page, sdk, gotoSession }) => {
  await withSession(sdk, `e2e ws-chip hidden ${Date.now()}`, async (session) => {
    await gotoSession(session.id)
    await expect(page.locator('[data-action="prompt-workspace"]')).toHaveCount(0)
  })
})

test("outside click and Esc dismiss popover", async ({ page, project }) => {
  await project.open()
  const chip = page.locator('[data-action="prompt-workspace"]')
  await chip.click()
  await expect(page.getByRole("menu")).toBeVisible()

  await page.keyboard.press("Escape")
  await expect(page.getByRole("menu")).toHaveCount(0)

  await chip.click()
  // deterministic outside-click target: the home hero heading region
  await page.locator('[data-component="session-new-home"]').getByRole("heading").first().click()
  await expect(page.getByRole("menu")).toHaveCount(0)
})
