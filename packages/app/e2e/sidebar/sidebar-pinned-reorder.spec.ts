import { test, expect } from "../fixtures"
import { openSidebar } from "../actions"
import { pawworkSidebarSelector } from "../selectors"

// Keyboard-accessible reorder within the pinned zone. Mouse drag is pointer-only
// (SortableJS forceFallback, covered by sidebar-drag-pointer.spec.ts); these
// specs cover the keyboard path: with focus on a pinned row, ⌥↑ / ⌥↓
// (Alt+Arrow) moves it. The menu no longer carries Move up / Move down — that
// surface is asserted by session-menu-actions.test.ts.

test("pinned rows reorder via ⌥↑ / ⌥↓ on the focused row", async ({ page, sdk, gotoSession }) => {
  const stamp = Date.now()
  const a = await sdk.session.create({ title: `pinned-reorder a ${stamp}` }).then((r) => r.data)
  const b = await sdk.session.create({ title: `pinned-reorder b ${stamp}` }).then((r) => r.data)

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

  const pinned = sidebar.locator('[data-component="pawwork-sidebar-pinned"]')
  await expect(pinned.locator(`[data-session-id="${b.id}"]`)).toBeVisible()

  // togglePinnedSession prepends each new pin, so pinning a then b yields the
  // pinned order [b, a] — b on top, a on the bottom.
  const order = async () =>
    (
      await pinned
        .locator("[data-session-id]")
        .evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).dataset.sessionId))
    ).filter(Boolean) as string[]

  expect(await order()).toEqual([b.id, a.id])

  const focusRow = (id: string) => pinned.locator(`[data-session-id="${id}"] a`).first().focus()

  // Move b (top) down → [a, b].
  await focusRow(b.id)
  await page.keyboard.press("Alt+ArrowDown")
  await expect.poll(order).toEqual([a.id, b.id])

  // Move b (now bottom) back up → [b, a]. Re-focus: the move re-renders the row.
  await focusRow(b.id)
  await page.keyboard.press("Alt+ArrowUp")
  await expect.poll(order).toEqual([b.id, a.id])
})

test("⌥↑ on the top pinned row and ⌥↓ on the bottom are silent no-ops", async ({ page, sdk, gotoSession }) => {
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
  const order = async () =>
    (
      await pinned
        .locator("[data-session-id]")
        .evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).dataset.sessionId))
    ).filter(Boolean) as string[]

  expect(await order()).toEqual([b.id, a.id])

  // ⌥↑ on the top row (b) cannot go higher.
  await pinned.locator(`[data-session-id="${b.id}"] a`).first().focus()
  await page.keyboard.press("Alt+ArrowUp")
  await expect.poll(order).toEqual([b.id, a.id])

  // ⌥↓ on the bottom row (a) cannot go lower.
  await pinned.locator(`[data-session-id="${a.id}"] a`).first().focus()
  await page.keyboard.press("Alt+ArrowDown")
  await expect.poll(order).toEqual([b.id, a.id])
})

test("⌥↑ / ⌥↓ on a non-pinned row neither pins nor reorders it", async ({ page, sdk, gotoSession }) => {
  const stamp = Date.now()
  const session = await sdk.session.create({ title: `unpinned-noop ${stamp}` }).then((r) => r.data)

  if (!session?.id) throw new Error("missing session id")

  await gotoSession(session.id)
  await openSidebar(page)

  const sidebar = page.locator(pawworkSidebarSelector).first()

  // Focus the (non-pinned) row and press the reorder keys.
  await sidebar.locator(`[data-session-id="${session.id}"] a`).first().focus()
  await page.keyboard.press("Alt+ArrowDown")
  await page.keyboard.press("Alt+ArrowUp")

  // The keys only act on rows in the visible pinned order, so nothing was
  // pinned: the pinned section never materialises for this session.
  await expect(
    sidebar.locator(`[data-component="pawwork-sidebar-pinned"] [data-session-id="${session.id}"]`),
  ).toHaveCount(0)
})
