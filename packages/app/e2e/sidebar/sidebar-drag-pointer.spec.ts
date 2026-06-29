import type { Page } from "@playwright/test"
import { test, expect } from "../fixtures"
import { openSidebar } from "../actions"
import { pawworkSidebarSelector } from "../selectors"

/**
 * Low-level pointer-driven regression for the real SortableJS drag path.
 *
 * Playwright's high-level `dragTo()` is HTML5 DnD only; SortableJS runs in
 * `forceFallback: true` mode and listens for mousedown / mousemove / mouseup
 * (plus pointer variants). `page.mouse.{down,move,up}` dispatches those, so
 * we can actually drive the spike's most fragile path: drag-then-revert-DOM,
 * Solid reconciler re-renders, no duplicate rows.
 *
 * The test is tagged @smoke so PR CI (which filters by --grep @smoke) picks
 * it up; without the tag this regression would only run on full e2e runs.
 *
 * Drop targets are anchored on stable `data-component` selectors rather than
 * i18n text — the "All" header copy is actually "All sessions" / "全部会话",
 * so a text=/^All$/ matcher would silently fail (or worse, drift across
 * locales).
 */

const SORTABLE_DRAG_THRESHOLD_PX = 8 // comfortably above the configured fallbackTolerance (5px in pawwork-sidebar-drag.ts) so the nudge reliably starts a drag

async function startDragFrom(
  page: Page,
  origin: { x: number; y: number; width: number; height: number },
) {
  await page.mouse.move(origin.x + origin.width / 2, origin.y + origin.height / 2)
  await page.mouse.down()
  // First nudge past Sortable's start threshold; small step count keeps it
  // close to a real user's initial movement.
  await page.mouse.move(
    origin.x + origin.width / 2 + SORTABLE_DRAG_THRESHOLD_PX + 2,
    origin.y + origin.height / 2 + SORTABLE_DRAG_THRESHOLD_PX + 2,
    { steps: 4 },
  )
}

async function driftToAndDrop(
  page: Page,
  target: { x: number; y: number; width: number; height: number },
) {
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 20 })
  await page.mouse.up()
}

test("@smoke real drag (pointer) round-trips Pinned ↔ All without duplicating rows", async ({
  page,
  sdk,
  gotoSession,
}) => {
  const stamp = Date.now()
  const a = await sdk.session.create({ title: `drag-pointer a ${stamp}` }).then((r) => r.data)
  const b = await sdk.session.create({ title: `drag-pointer b ${stamp}` }).then((r) => r.data)
  if (!a?.id || !b?.id) throw new Error("missing session ids")

  await gotoSession(a.id)
  await openSidebar(page)

  const sidebar = page.locator(pawworkSidebarSelector).first()

  // No pin yet → pinned section is not rendered.
  await expect(sidebar.locator('[data-component="pawwork-sidebar-pinned"]')).toHaveCount(0)

  // Pin b via the menu so the pinned section exists for the first drag.
  const bRowMenu = sidebar.locator(`[data-session-id="${b.id}"]`).first()
  await bRowMenu.hover()
  await bRowMenu.locator('[data-action="session-row-menu"]').click()
  await page.getByRole("menuitem", { name: /^pin session$/i }).click()

  const pinned = sidebar.locator('[data-component="pawwork-sidebar-pinned"]')
  await expect(pinned.locator(`[data-session-id="${b.id}"]`)).toBeVisible()

  // Round 1: drag b OUT of Pinned, into the recent list.
  // The recent list is anchored by [data-component="pawwork-recent-list"] —
  // structural locator, no i18n coupling.
  const bWrapperPinned = pinned.locator(`.pw-drag-row[data-pw-drag-session-id="${b.id}"]`)
  const bBoxPinned = await bWrapperPinned.boundingBox()
  const recentList = sidebar.locator('[data-component="pawwork-recent-list"]')
  const recentBox = await recentList.boundingBox()
  if (!bBoxPinned || !recentBox) throw new Error("missing bounding boxes for drag-out")

  await startDragFrom(page, bBoxPinned)
  await driftToAndDrop(page, recentBox)

  await expect(pinned.locator(`[data-session-id="${b.id}"]`)).toHaveCount(0, { timeout: 5_000 })

  // Round 2: drag b BACK into Pinned. The pinned section is now empty and
  // gated on isDragging (按需浮现) — it only mounts after the drag starts.
  // Capture the recent-list wrapper position first, kick off the drag, then
  // wait for the pinned section to materialise and aim at its drop zone.
  const bWrapperRecent = sidebar.locator(`.pw-drag-row[data-pw-drag-session-id="${b.id}"]`).first()
  const bBoxRecent = await bWrapperRecent.boundingBox()
  if (!bBoxRecent) throw new Error("missing bBox for drag-in")

  await startDragFrom(page, bBoxRecent)
  // Pinned section surfaces after the drag-start tick — wait before targeting.
  await expect(pinned).toBeVisible({ timeout: 2_000 })
  const pinnedListBox = await sidebar.locator('[data-component="pawwork-pinned-list"]').boundingBox()
  if (!pinnedListBox) throw new Error("missing pinned list bBox")
  await driftToAndDrop(page, pinnedListBox)

  await expect(pinned.locator(`[data-session-id="${b.id}"]`)).toBeVisible({ timeout: 5_000 })

  // Hard regression assertion: b appears EXACTLY ONCE in the sidebar after
  // the round-trip. Duplicate rows would prove the DOM-revert path broke.
  await expect(sidebar.locator(`[data-session-id="${b.id}"]`)).toHaveCount(1)
})
