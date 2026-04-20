import { test, expect } from "../fixtures"
import { cleanupTestProject, closeSidebar, createTestProject } from "../actions"
import {
  pawworkSessionNewSelector,
  pawworkSessionSearchSelector,
  pawworkSidebarSelector,
  projectSwitchSelector,
  sessionItemSelector,
} from "../selectors"
import { dirSlug } from "../utils"

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
  await expect(page.locator('[data-component="sidebar-rail"]')).toHaveCount(0)
  const sortButton = page.locator(`${pawworkSidebarSelector} [data-action="pawwork-sort-mode"]`).first()
  await expect(sortButton).toBeVisible()
  await expect(sortButton).toHaveAttribute("data-mode", /time|project/)
  await expect(sortButton).toHaveText("")
  await expect(page.locator(`${sessionItemSelector(seeded!.id)} [data-session-skill="document-processing"]`)).toBeVisible()
})

test.skip("collapsed PawWork peek shows sessions for the hovered project only", async ({ page, project }) => {
  await page.setViewportSize({ width: 1400, height: 800 })

  const stamp = Date.now()
  const other = await createTestProject()

  try {
    const otherSlug = dirSlug(other)

    await project.open({ extra: [other] })

    const current = await project.sdk.session.create({ title: `peek current ${stamp}` }).then((res) => res.data)
    const hovered = await project.sdk
      .session.create({ directory: other, title: `peek hovered ${stamp}` })
      .then((res) => res.data)

    if (!current?.id || !hovered?.id) throw new Error("missing session ids")

    await project.gotoSession(current.id)
    await closeSidebar(page)

    const button = page.locator(projectSwitchSelector(otherSlug)).first()
    await expect(button).toBeVisible()
    await button.hover()

    const peekSidebar = page
      .locator('[data-component="pawwork-sidebar"][data-sidebar-scope="peek"]')
      .first()

    await expect(peekSidebar).toBeVisible()
    await expect(peekSidebar.locator(`[data-session-id="${hovered.id}"]`)).toBeVisible()
    await expect(peekSidebar.locator(`[data-session-id="${current.id}"]`)).toHaveCount(0)
  } finally {
    await cleanupTestProject(other)
  }
})

test("PawWork sidebar keeps the active session row in view on long lists", async ({ page, sdk, gotoSession }) => {
  await page.setViewportSize({ width: 1400, height: 720 })

  const stamp = Date.now()
  const sessions = [] as { id: string }[]

  for (let i = 0; i < 24; i++) {
    const created = await sdk.session.create({ title: `sidebar scroll ${stamp} ${i}` }).then((res) => res.data)
    if (!created?.id) throw new Error("missing session id")
    sessions.push({ id: created.id })
  }

  const target = sessions[0]
  await gotoSession(target.id)

  const scroller = page.locator(`${pawworkSidebarSelector} [data-component="pawwork-session-scroll"]`).first()
  const row = page.locator(`${pawworkSidebarSelector} [data-session-id="${target.id}"]`).first()

  await expect(scroller).toBeVisible()
  await expect(row).toBeVisible()
  await expect.poll(async () => scroller.evaluate((el) => el.scrollTop > 0)).toBe(true)
})
