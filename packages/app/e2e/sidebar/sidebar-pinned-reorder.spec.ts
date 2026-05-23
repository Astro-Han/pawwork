import { test, expect } from "../fixtures"
import { openSidebar } from "../actions"
import { pawworkSidebarSelector } from "../selectors"

// Menu-driven keyboard-accessible reorder within the pinned zone. SortableJS
// drag itself uses pointer-event fallback (forceFallback: true), which
// Playwright's high-level dragTo() does not drive. The real-pointer path
// is covered by sidebar-drag-pointer.spec.ts via page.mouse.{down,move,up};
// the menu actions here back the keyboard-accessible reorder path.
test("pinned sessions can be reordered via the Move up / Move down menu", async ({
  page,
  sdk,
  gotoSession,
}) => {
  const stamp = Date.now()
  const a = await sdk.session.create({ title: `pinned-reorder a ${stamp}` }).then((r) => r.data)
  const b = await sdk.session.create({ title: `pinned-reorder b ${stamp}` }).then((r) => r.data)

  if (!a?.id || !b?.id) throw new Error("missing session ids")

  await gotoSession(a.id)
  await openSidebar(page)

  const sidebar = page.locator(pawworkSidebarSelector).first()

  // Pin both via the existing menu Pin action so we land in the same order
  // togglePinnedSession produces (prepend → b then a in pinned).
  const pinViaMenu = async (id: string) => {
    const row = sidebar.locator(`[data-session-id="${id}"]`).first()
    await row.hover()
    await row.locator('[data-action="session-row-menu"]').click()
    await page.getByRole("menuitem", { name: /^pin session$/i }).click()
  }

  await pinViaMenu(a.id)
  await pinViaMenu(b.id)

  const pinned = sidebar.locator('[data-component="pawwork-sidebar-pinned"]')
  await expect(pinned.locator(`[data-session-id="${b.id}"]`)).toBeVisible()
  await expect(pinned.locator(`[data-session-id="${a.id}"]`)).toBeVisible()

  // After pinning b then a in that order, togglePinnedSession prepends each
  // new pin to the front of pawworkPinnedSessions: [a] -> [b, a] after the
  // second call. So at this point the order is b (top) then a (bottom).
  const initialOrder = async () =>
    (
      await pinned
        .locator("[data-session-id]")
        .evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).dataset.sessionId))
    ).filter(Boolean) as string[]

  expect(await initialOrder()).toEqual([b.id, a.id])

  // Move b down via the menu — order should flip to [a, b].
  const bRow = pinned.locator(`[data-session-id="${b.id}"]`).first()
  await bRow.hover()
  await bRow.locator('[data-action="session-row-menu"]').click()
  await page.getByRole("menuitem", { name: /^move down$/i }).click()

  await expect.poll(initialOrder).toEqual([a.id, b.id])

  // Move b back up — order returns to [b, a].
  const bRowAfter = pinned.locator(`[data-session-id="${b.id}"]`).first()
  await bRowAfter.hover()
  await bRowAfter.locator('[data-action="session-row-menu"]').click()
  await page.getByRole("menuitem", { name: /^move up$/i }).click()

  await expect.poll(initialOrder).toEqual([b.id, a.id])
})

test("Move up is hidden for the top pinned row, Move down hidden for the bottom", async ({
  page,
  sdk,
  gotoSession,
}) => {
  const stamp = Date.now()
  const a = await sdk.session.create({ title: `pinned-edge a ${stamp}` }).then((r) => r.data)
  const b = await sdk.session.create({ title: `pinned-edge b ${stamp}` }).then((r) => r.data)

  if (!a?.id || !b?.id) throw new Error("missing session ids")

  await gotoSession(a.id)
  await openSidebar(page)

  const sidebar = page.locator(pawworkSidebarSelector).first()

  const pinViaMenu = async (id: string) => {
    const row = sidebar.locator(`[data-session-id="${id}"]`).first()
    await row.hover()
    await row.locator('[data-action="session-row-menu"]').click()
    await page.getByRole("menuitem", { name: /^pin session$/i }).click()
  }

  await pinViaMenu(a.id)
  await pinViaMenu(b.id)

  // pinned order is [b, a] — b is top, a is bottom.
  const pinned = sidebar.locator('[data-component="pawwork-sidebar-pinned"]')

  // Open menu on top row (b): expect no Move up.
  const bRow = pinned.locator(`[data-session-id="${b.id}"]`).first()
  await bRow.hover()
  await bRow.locator('[data-action="session-row-menu"]').click()
  await expect(page.getByRole("menuitem", { name: /^move up$/i })).toHaveCount(0)
  await expect(page.getByRole("menuitem", { name: /^move down$/i })).toBeVisible()
  await page.keyboard.press("Escape")

  // Open menu on bottom row (a): expect no Move down.
  const aRow = pinned.locator(`[data-session-id="${a.id}"]`).first()
  await aRow.hover()
  await aRow.locator('[data-action="session-row-menu"]').click()
  await expect(page.getByRole("menuitem", { name: /^move down$/i })).toHaveCount(0)
  await expect(page.getByRole("menuitem", { name: /^move up$/i })).toBeVisible()
  await page.keyboard.press("Escape")
})

test("non-pinned rows do not show Move up or Move down menu items", async ({ page, sdk, gotoSession }) => {
  const stamp = Date.now()
  const session = await sdk.session.create({ title: `unpinned no move ${stamp}` }).then((r) => r.data)

  if (!session?.id) throw new Error("missing session id")

  await gotoSession(session.id)
  await openSidebar(page)

  const sidebar = page.locator(pawworkSidebarSelector).first()
  const row = sidebar.locator(`[data-session-id="${session.id}"]`).first()

  await row.hover()
  await row.locator('[data-action="session-row-menu"]').click()

  await expect(page.getByRole("menuitem", { name: /^pin session$/i })).toBeVisible()
  await expect(page.getByRole("menuitem", { name: /^move up$/i })).toHaveCount(0)
  await expect(page.getByRole("menuitem", { name: /^move down$/i })).toHaveCount(0)
})
