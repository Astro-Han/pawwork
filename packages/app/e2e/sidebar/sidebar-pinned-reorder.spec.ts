import { test, expect } from "../fixtures"
import { openSidebar } from "../actions"
import { pawworkSidebarSelector } from "../selectors"

// Keyboard-accessible reorder within the pinned zone. Mouse drag is pointer-only
// (SortableJS forceFallback, covered by sidebar-drag-pointer.spec.ts); these
// specs cover the keyboard path: with focus on a pinned row, ⌥↑ / ⌥↓
// (Alt+Arrow) moves it. Note: session.previous/next bind the SAME alt+arrow
// globally, so the reorder must claim the event (stopPropagation) and not also
// navigate — several assertions below pin that down via an unchanged URL.

test("pinned rows reorder via ⌥↑ / ⌥↓ without navigating away", async ({ page, sdk, gotoSession }) => {
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

  // The active session is `a`; reorder must not navigate away from it.
  const urlBefore = page.url()
  const focusRow = (id: string) => pinned.locator(`[data-session-id="${id}"] a`).first().focus()

  // Move b (top) down → [a, b].
  await focusRow(b.id)
  await page.keyboard.press("Alt+ArrowDown")
  await expect.poll(order).toEqual([a.id, b.id])

  // Move b (now bottom) back up → [b, a]. Re-focus: the move re-renders the row.
  await focusRow(b.id)
  await page.keyboard.press("Alt+ArrowUp")
  await expect.poll(order).toEqual([b.id, a.id])

  // Critical: reordering claimed the event, so session.previous/next never fired.
  expect(page.url()).toBe(urlBefore)
})

test("⌥↑ at the top and ⌥↓ at the bottom are no-ops that never navigate", async ({ page, sdk, gotoSession }) => {
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
  const urlBefore = page.url()

  // ⌥↑ on the top row (b) cannot go higher — and must not navigate.
  await pinned.locator(`[data-session-id="${b.id}"] a`).first().focus()
  await page.keyboard.press("Alt+ArrowUp")
  await expect.poll(order).toEqual([b.id, a.id])
  expect(page.url()).toBe(urlBefore)

  // ⌥↓ on the bottom row (a) cannot go lower — and must not navigate.
  await pinned.locator(`[data-session-id="${a.id}"] a`).first().focus()
  await page.keyboard.press("Alt+ArrowDown")
  await expect.poll(order).toEqual([b.id, a.id])
  expect(page.url()).toBe(urlBefore)
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

test("Shift+Alt / Mod+Alt + Arrow on a pinned row are left to the global commands", async ({
  page,
  sdk,
  gotoSession,
}) => {
  const stamp = Date.now()
  const a = await sdk.session.create({ title: `pinned-modifier a ${stamp}` }).then((r) => r.data)
  const b = await sdk.session.create({ title: `pinned-modifier b ${stamp}` }).then((r) => r.data)

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
  const order = async () =>
    (
      await pinned
        .locator("[data-session-id]")
        .evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).dataset.sessionId))
    ).filter(Boolean) as string[]

  expect(await order()).toEqual([b.id, a.id])

  // The reorder handler accepts plain Alt+Arrow only. Shift+Alt and Mod+Alt are
  // bound to other global session commands, so they must NOT reorder the pinned
  // zone — the order stays put regardless of what the global command does.
  await pinned.locator(`[data-session-id="${b.id}"] a`).first().focus()
  await page.keyboard.press("Shift+Alt+ArrowDown")
  await page.keyboard.press("ControlOrMeta+Alt+ArrowDown")
  expect(await order()).toEqual([b.id, a.id])
})

test("Alt+Arrow while the “…” menu button is focused does not reorder", async ({ page, sdk, gotoSession }) => {
  const stamp = Date.now()
  const a = await sdk.session.create({ title: `pinned-menu a ${stamp}` }).then((r) => r.data)
  const b = await sdk.session.create({ title: `pinned-menu b ${stamp}` }).then((r) => r.data)

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
  const order = async () =>
    (
      await pinned
        .locator("[data-session-id]")
        .evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).dataset.sessionId))
    ).filter(Boolean) as string[]

  expect(await order()).toEqual([b.id, a.id])

  // Only the row's main link owns ⌥↑/⌥↓ — the keycap hint shows on a:focus-visible
  // only, so the "…" menu button never displays it. Focusing that button and
  // pressing Alt+Arrow must be inert: no reorder, no focus jump to the link.
  await pinned.locator(`[data-session-id="${b.id}"] [data-action="session-row-menu"]`).first().focus()
  await page.keyboard.press("Alt+ArrowDown")
  expect(await order()).toEqual([b.id, a.id])
})
