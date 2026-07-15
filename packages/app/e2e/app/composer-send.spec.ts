import { expect, test } from "../fixtures"
import { promptSelector, sessionComposerDockSelector } from "../selectors"

test("send disabled on empty input", async ({ page, project }) => {
  await project.open()
  const send = page.locator(sessionComposerDockSelector).locator('[data-action="prompt-submit"]')
  await expect(send).toBeDisabled()
})

test("send enabled with non-empty input", async ({ page, project }) => {
  await project.open()
  const prompt = page.locator(promptSelector)
  await prompt.click()
  await page.keyboard.type("hello")
  const send = page.locator(sessionComposerDockSelector).locator('[data-action="prompt-submit"]')
  await expect(send).toBeEnabled()
})

test("existing session stays sendable while status hydration is pending", async ({ page, project, assistant }) => {
  let statusRequested = false
  await page.route(/\/session\/status(?:\?|$)/, async () => {
    statusRequested = true
    await new Promise<never>(() => undefined)
  })

  let sessionID = ""
  await project.open({
    beforeGoto: async ({ sdk }) => {
      const session = await sdk.session.create({ title: "Pending status hydration" }).then((response) => response.data)
      if (!session?.id) throw new Error("Failed to create pending-status session")
      sessionID = session.id
      await sdk.session.prompt({
        sessionID,
        noReply: true,
        parts: [{ type: "text", text: "Seed an existing conversation." }],
      })
    },
  })
  project.trackSession(sessionID)
  await project.gotoSession(sessionID)
  await expect.poll(() => statusRequested).toBe(true)

  const prompt = page.locator(promptSelector)
  await prompt.click()
  await page.keyboard.type("/compact")

  const send = page.locator(sessionComposerDockSelector).locator('[data-action="prompt-submit"]')
  await expect(send).toBeEnabled()

  const compact = page.locator('[data-slash-id="session.compact"]')
  await expect(compact).toBeVisible()
  await assistant.reply("Compacted conversation summary.")
  await compact.click()
  await expect(page.locator('[data-slot="session-turn-compaction"]')).toBeVisible()
})
