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
 * If these flake, they're still cheaper to debug than a manual walk-through —
 * the failing screenshot/trace immediately shows what went wrong.
 */

const SORTABLE_DRAG_THRESHOLD_PX = 8 // SortableJS internal default before fallback considers a drag started

async function dragRow(
  page: Page,
  fromBox: { x: number; y: number; width: number; height: number },
  toBox: { x: number; y: number; width: number; height: number },
) {
  // Origin of drag: row centre.
  await page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2)
  await page.mouse.down()
  // First nudge past Sortable's start threshold.
  await page.mouse.move(
    fromBox.x + fromBox.width / 2 + SORTABLE_DRAG_THRESHOLD_PX + 2,
    fromBox.y + fromBox.height / 2 + SORTABLE_DRAG_THRESHOLD_PX + 2,
    { steps: 4 },
  )
  // Then drift to the target slot in many small steps so Sortable's hover
  // hit-testing runs each frame.
  await page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, { steps: 20 })
  await page.mouse.up()
}

test("real drag (pointer) moves a row from All into Pinned and back without duplicating", async ({
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

  // Sanity: pinned section is not rendered before any pin (no rows + not dragging).
  await expect(sidebar.locator('[data-component="pawwork-sidebar-pinned"]')).toHaveCount(0)

  // Pin b via the menu so the pinned section exists, then drag b OUT (Pinned → All)
  // and back IN (All → Pinned). This is the round-trip the DOM-revert path
  // is most exposed to: if the revert misses, the source row stays
  // SortableJS-mutated and Solid's <For> reconciler appends a duplicate.
  const pinViaMenu = async (id: string) => {
    const row = sidebar.locator(`[data-session-id="${id}"]`).first()
    await row.hover()
    await row.locator('[data-action="session-row-menu"]').click()
    await page.getByRole("menuitem", { name: /^pin session$/i }).click()
  }
  await pinViaMenu(b.id)

  const pinned = sidebar.locator('[data-component="pawwork-sidebar-pinned"]')
  await expect(pinned.locator(`[data-session-id="${b.id}"]`)).toBeVisible()

  // Round 1: drag b from Pinned back down into All.
  const bWrapperPinned = pinned.locator(`.pw-drag-row[data-pw-drag-session-id="${b.id}"]`)
  const bBoxPinned = await bWrapperPinned.boundingBox()
  const recent = sidebar.locator('[data-component="pawwork-recent-list"]')
  const recentBox = await recent.boundingBox()
  if (!bBoxPinned || !recentBox) throw new Error("missing bounding boxes for drag-out")

  await dragRow(page, bBoxPinned, {
    x: recentBox.x,
    y: recentBox.y + recentBox.height / 2,
    width: recentBox.width,
    height: 1,
  })

  await expect(pinned.locator(`[data-session-id="${b.id}"]`)).toHaveCount(0, { timeout: 5_000 })

  // Round 2: drag b back UP into the (now empty) pinned zone. Pinned section
  // is hidden again until the drag starts (按需浮现 — surfaces during isDragging).
  const bWrapperRecent = sidebar.locator(`.pw-drag-row[data-pw-drag-session-id="${b.id}"]`).first()
  const bBoxRecent = await bWrapperRecent.boundingBox()
  if (!bBoxRecent) throw new Error("missing bBox for drag-in")

  // Aim for above the All header — that's where pinned will materialise.
  const allHeader = sidebar.locator("text=/^All$/i").first()
  const allBox = await allHeader.boundingBox()
  if (!allBox) throw new Error("missing All header bBox")

  await dragRow(page, bBoxRecent, {
    x: allBox.x,
    // 24 px above the All header — well inside the emptyInsertThreshold (32)
    // we set on the pinned Sortable instance.
    y: allBox.y - 12,
    width: allBox.width,
    height: 1,
  })

  await expect(pinned.locator(`[data-session-id="${b.id}"]`)).toBeVisible({ timeout: 5_000 })

  // Hard regression assertion: b appears EXACTLY ONCE in the sidebar after
  // the round-trip. Duplicate rows would prove the DOM-revert path broke.
  await expect(sidebar.locator(`[data-session-id="${b.id}"]`)).toHaveCount(1)
})
