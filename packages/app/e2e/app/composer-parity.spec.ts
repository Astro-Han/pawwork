import { expect, test } from "../fixtures"
import { sessionComposerDockSelector } from "../selectors"
import { withSession } from "../actions"

async function collectBarSet(bar: ReturnType<typeof import("@playwright/test").Page.prototype.locator>) {
  const actions = await bar
    .locator("[data-action]")
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-action")).filter((v): v is string => !!v))
  const chipComponents = await bar
    .locator('[data-component="prompt-model-control"], [data-component="prompt-variant-control"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute("data-component")).filter((v): v is string => !!v))
  return new Set([...actions, ...chipComponents])
}

test("home and session composers share the same bottom-bar subcomponent set", async ({
  page,
  project,
  sdk,
  gotoSession,
}) => {
  await project.open()
  const homeBar = page.locator(sessionComposerDockSelector).first()
  await expect(homeBar).toBeVisible()
  const homeActions = await collectBarSet(homeBar)

  await withSession(sdk, `e2e parity ${Date.now()}`, async (session) => {
    await gotoSession(session.id)
    const sessionBar = page.locator(sessionComposerDockSelector).first()
    await expect(sessionBar).toBeVisible()
    const sessionActions = await collectBarSet(sessionBar)

    // session bar lacks only the workspace chip; everything else matches as a set
    const expected = new Set([...homeActions].filter((a) => a !== "prompt-workspace"))
    expect([...sessionActions].sort()).toEqual([...expected].sort())
  })
})
