import { expect, test } from "../fixtures"
import { promptSelector, sessionComposerDockSelector } from "../selectors"
import { composeGrid, snapOutputPath } from "./_compose"

test.use({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 2 })

test("session-status-readiness", async ({ page, project }) => {
  await page.route(/\/session\/status(?:\?|$)/, async () => {
    await new Promise<never>(() => undefined)
  })

  let sessionID = ""
  await project.open({
    beforeGoto: async ({ sdk }) => {
      const session = await sdk.session.create({ title: "Pending status hydration" }).then((response) => response.data)
      if (!session?.id) throw new Error("Failed to create pending-status session")
      sessionID = session.id
      project.trackSession(sessionID)
      await sdk.session.prompt({
        sessionID,
        noReply: true,
        parts: [{ type: "text", text: "Seed an existing conversation." }],
      })
    },
  })
  await project.gotoSession(sessionID)

  const prompt = page.locator(promptSelector)
  await prompt.click()
  await page.keyboard.type("/compact")

  const composer = page.locator(sessionComposerDockSelector)
  await expect(composer.locator('[data-action="prompt-submit"]')).toBeEnabled()

  const out = snapOutputPath("session-status-readiness")
  await composeGrid([{ name: "pending-status-send-enabled", buf: await composer.screenshot() }], out, { cols: 1 })
  process.stdout.write(`\n[snap] session-status-readiness grid -> ${out}\n\n`)
})
