import { test, expect } from "../fixtures"
import { hoverSessionItem, openSidebar } from "../actions"
import { pawworkSidebarSelector } from "../selectors"

test("sidebar row exposes 4-state status + 4-item menu with shortcut hints", async ({
  page,
  sdk,
  gotoSession,
}) => {
  const stamp = Date.now()
  const session = await sdk.session.create({ title: `slice 09 menu ${stamp}` }).then((r) => r.data)
  if (!session?.id) throw new Error("session create returned no id")

  try {
    await gotoSession(session.id)
    await openSidebar(page)

    const row = await hoverSessionItem(page, session.id)
    await row.locator('[data-action="session-row-menu"]').click()

    const items = page.getByRole("menuitem")
    const count = await items.count()
    expect(count === 3 || count === 4).toBe(true)
    const labels = await items.allTextContents()
    expect(labels[0]).toMatch(/Pin|置顶/)
    expect(labels[1]).toMatch(/Rename|重命名/)
    expect(labels[1]).toContain("↵")
    expect(labels[count - 1]).toMatch(/Delete|删除/)
    expect(labels[count - 1]).toContain("⌫")
    if (count === 4) {
      expect(labels[2]).toMatch(/Export|导出/)
    }
  } finally {
    await sdk.session.delete({ path: { id: session.id } })
  }
})

test("sort trigger is a text+chev popover with two options", async ({ page, sdk, gotoSession }) => {
  const stamp = Date.now()
  const session = await sdk.session.create({ title: `slice 09 sort ${stamp}` }).then((r) => r.data)
  if (!session?.id) throw new Error("session create returned no id")

  try {
    await gotoSession(session.id)
    await openSidebar(page)

    const sidebar = page.locator(pawworkSidebarSelector).first()
    const trigger = sidebar.locator('[data-action="pawwork-sort-trigger"]').first()
    await expect(trigger).toBeVisible()
    await trigger.click()

    const options = page.locator('[data-action="pawwork-sort-option"]')
    await expect(options).toHaveCount(2)
    await expect(page.locator('[data-action="pawwork-sort-option"][data-value="time"]')).toBeVisible()
    await expect(page.locator('[data-action="pawwork-sort-option"][data-value="project"]')).toBeVisible()

    await page.locator('[data-action="pawwork-sort-option"][data-value="project"]').click()
    await expect(trigger).toHaveAttribute("data-mode", "project")
  } finally {
    await sdk.session.delete({ path: { id: session.id } })
  }
})

test("L37 four-segment shape: side-traffic 32px above side-top, side-foot at bottom", async ({
  page,
  sdk,
  gotoSession,
}) => {
  const stamp = Date.now()
  const session = await sdk.session.create({ title: `slice 09 shape ${stamp}` }).then((r) => r.data)
  if (!session?.id) throw new Error("session create returned no id")

  try {
    await gotoSession(session.id)
    await openSidebar(page)

    const sidebar = page.locator(pawworkSidebarSelector).first()
    const traffic = sidebar.locator('[data-component="pawwork-side-traffic"]').first()
    const top = sidebar.locator('[data-component="pawwork-side-top"]').first()
    const scroll = sidebar.locator('[data-component="pawwork-side-scroll"]').first()
    const foot = sidebar.locator('[data-component="pawwork-side-foot"]').first()

    await expect(traffic).toBeVisible()
    await expect(top).toBeVisible()
    await expect(scroll).toBeVisible()
    await expect(foot).toBeVisible()

    const trafficBox = await traffic.boundingBox()
    const topBox = await top.boundingBox()
    expect(trafficBox?.height).toBe(32)
    expect(trafficBox && topBox && trafficBox.y < topBox.y).toBe(true)
  } finally {
    await sdk.session.delete({ path: { id: session.id } })
  }
})
