import { test, expect } from "../fixtures"
import { promptSelector, sessionComposerDockSelector } from "../selectors"
import { withSession } from "../actions"

test("can open an existing session and type into the prompt", async ({ page, sdk, gotoSession }) => {
  const title = `e2e smoke ${Date.now()}`

  await withSession(sdk, title, async (session) => {
    await gotoSession(session.id)

    const prompt = page.locator(promptSelector)
    await prompt.click()
    await page.keyboard.type("hello from e2e")
    await expect(prompt).toContainText("hello from e2e")
  })
})

test("@smoke session composer matches home structure without docktray or agent control", async ({
  page,
  sdk,
  gotoSession,
}) => {
  const title = `e2e unified ${Date.now()}`

  await withSession(sdk, title, async (session) => {
    await gotoSession(session.id)

    const composer = page.locator(sessionComposerDockSelector)
    await expect(composer).toBeVisible()

    // no DockTray surface
    await expect(composer.locator('[data-dock-surface="tray"]')).toHaveCount(0)

    // no Agent selector
    await expect(page.locator('[data-component="prompt-agent-control"]')).toHaveCount(0)

    // WorkspaceChip hidden in session (breadcrumb replaces it)
    await expect(page.getByRole("button", { name: /Switch workspace|切换工作目录/i })).toHaveCount(0)

    // Model + Variant controls are inside the unified bar
    await expect(composer.locator('[data-component="prompt-model-control"]')).toBeVisible()
    await expect(composer.locator('[data-component="prompt-variant-control"]')).toBeVisible()

    // send button is the brand-orange circle
    const send = composer.locator('[data-action="prompt-submit"]')
    await expect(send).toBeVisible()
  })
})
