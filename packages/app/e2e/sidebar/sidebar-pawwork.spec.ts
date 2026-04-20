import { test, expect } from "../fixtures"
import { pawworkSessionNewSelector, pawworkSessionSearchSelector, pawworkSidebarSelector, sessionItemSelector } from "../selectors"

test("PawWork sidebar starts expanded and shows session skill badges", async ({ page, sdk, gotoSession }) => {
  const seeded = await sdk.session
    .create({
      title: `skill badge ${Date.now()}`,
      skill: "document-processing",
    })
    .then((res) => res.data)

  await gotoSession(seeded?.id)

  await expect(page.locator('[data-component="sidebar-nav-desktop"]')).toBeVisible()
  await expect(page.locator(pawworkSidebarSelector)).toBeVisible()
  await expect(page.locator(pawworkSessionNewSelector)).toBeVisible()
  await expect(page.locator(pawworkSessionSearchSelector)).toBeVisible()
  await expect(page.locator('[data-action="project-workspaces-toggle"]')).toHaveCount(0)
  await expect(page.locator('[data-action="workspace-new-session"]')).toHaveCount(0)
  await expect(page.locator(`${sessionItemSelector(seeded!.id)} [data-session-skill="document-processing"]`)).toBeVisible()
})
