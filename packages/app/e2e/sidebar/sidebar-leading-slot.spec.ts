import { expect, test } from "../fixtures"
import { openSidebar, withSession } from "../actions"
import { pawworkSidebarSelector } from "../selectors"

test("pawwork sidebar merges pin into the status slot with a stable title baseline", async ({
  page,
  sdk,
  gotoSession,
}) => {
  const stamp = Date.now()
  await withSession(sdk, `i150 regression ${stamp}`, async (session) => {
    await gotoSession(session.id)
    await openSidebar(page)

    const sidebar = page.locator(pawworkSidebarSelector).first()
    const row = sidebar.locator(`[data-session-id="${session.id}"]`).first()
    const title = row.locator("span", { hasText: `i150 regression ${stamp}` }).first()

    const leftOf = async (locator: typeof title) => {
      const rect = await locator.evaluate((el) => el.getBoundingClientRect())
      return Math.round(rect.left)
    }

    // Baseline: unpinned, no hover.
    await page.mouse.move(0, 0)
    await expect(row).toBeVisible()
    const baseline = await leftOf(title)

    // Hover must not shift the title horizontally (action slot grows on the right).
    await row.hover()
    expect(await leftOf(title)).toBe(baseline)

    // Pin via row menu; the row rerenders in the pinned section.
    await row.locator('[data-action="session-row-menu"]').click()
    await page.getByRole("menuitem", { name: /pin session/i }).click()
    const pinnedRow = sidebar
      .locator(`[data-component="pawwork-sidebar-pinned"] [data-session-id="${session.id}"]`)
      .first()
    await expect(pinnedRow).toBeVisible()

    const pinnedTitle = pinnedRow.locator("span", { hasText: `i150 regression ${stamp}` }).first()
    await page.mouse.move(0, 0)
    expect(await leftOf(pinnedTitle)).toBe(baseline)
    await pinnedRow.hover()
    expect(await leftOf(pinnedTitle)).toBe(baseline)

    // Pin button should occupy the row's leading slot, not a separate column.
    const pinButton = pinnedRow.locator('[data-action="pawwork-session-pin"][data-pinned="true"]').first()
    await expect(pinButton).toBeVisible()
    const pinRect = await pinButton.evaluate((el) => el.getBoundingClientRect())
    const rowRect = await pinnedRow.evaluate((el) => el.getBoundingClientRect())
    expect(Math.round(pinRect.left - rowRect.left)).toBe(8)
    expect(Math.round(pinRect.width)).toBe(24)
  })
})

test("pawwork sidebar keeps title width stable when the row action appears", async ({ page, sdk, gotoSession }) => {
  const STAMP = Date.now()
  const TITLE = `i192 regression long session title that should keep a stable truncation width ${STAMP}`

  await withSession(sdk, TITLE, async (session) => {
    await gotoSession(session.id)
    await openSidebar(page)

    const sidebar = page.locator(pawworkSidebarSelector).first()
    const row = sidebar.locator(`[data-session-id="${session.id}"]`).first()
    const titleNode = row.locator("span", { hasText: TITLE }).first()
    const menu = row.locator('[data-action="session-row-menu"]').first()

    const widthOf = async () => {
      const rect = await titleNode.evaluate((el) => el.getBoundingClientRect())
      return Math.round(rect.width)
    }

    await page.mouse.move(0, 0)
    await expect(row).toBeVisible()
    const baseline = await widthOf()

    await row.hover()
    expect(await widthOf()).toBe(baseline)

    await page.mouse.move(0, 0)
    await menu.focus()
    expect(await widthOf()).toBe(baseline)

    await page.keyboard.press("Enter")
    await expect(page.getByRole("menuitem", { name: /pin session/i })).toBeVisible()
    expect(await widthOf()).toBe(baseline)
  })
})
