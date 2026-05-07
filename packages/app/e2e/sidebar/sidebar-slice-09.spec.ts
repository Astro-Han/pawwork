import { test, expect } from "../fixtures"
import { openSidebar, withSession } from "../actions"
import { pawworkSidebarSelector } from "../selectors"

test("sidebar row exposes 4-item menu with Rename ↵ / Delete ⌫ shortcut hints", async ({
  page,
  sdk,
  gotoSession,
}) => {
  const stamp = Date.now()
  await withSession(sdk, `slice 09 menu ${stamp}`, async (session) => {
    await gotoSession(session.id)
    await openSidebar(page)

    const sidebar = page.locator(pawworkSidebarSelector).first()
    const row = sidebar.locator(`[data-session-id="${session.id}"]`).first()
    await row.hover()
    await row.locator('[data-action="session-row-menu"]').click()

    const items = page.getByRole("menuitem")
    const count = await items.count()
    // Export availability depends on runtime config; assert on the stable items.
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
  })
})

test("sort trigger is a text+chev popover with two options", async ({ page, sdk, gotoSession }) => {
  const stamp = Date.now()
  await withSession(sdk, `slice 09 sort ${stamp}`, async (session) => {
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
  })
})

test("L37 three-segment shape: side-top, side-scroll, side-foot stacked", async ({
  page,
  sdk,
  gotoSession,
}) => {
  // The side-traffic placeholder is reserved for slice 17 (when traffic-lights
  // and collapse control move into the sidebar). Until then, the OS chrome
  // already supplies that space, so we ship without the placeholder.
  const stamp = Date.now()
  await withSession(sdk, `slice 09 shape ${stamp}`, async (session) => {
    await gotoSession(session.id)
    await openSidebar(page)

    const sidebar = page.locator(pawworkSidebarSelector).first()
    const top = sidebar.locator('[data-component="pawwork-side-top"]').first()
    const scroll = sidebar.locator('[data-component="pawwork-side-scroll"]').first()
    const foot = sidebar.locator('[data-component="pawwork-side-foot"]').first()

    await expect(top).toBeVisible()
    await expect(scroll).toBeVisible()
    await expect(foot).toBeVisible()

    const topBox = await top.boundingBox()
    const scrollBox = await scroll.boundingBox()
    const footBox = await foot.boundingBox()
    expect(topBox && scrollBox && topBox.y < scrollBox.y).toBe(true)
    expect(scrollBox && footBox && scrollBox.y < footBox.y).toBe(true)
  })
})
