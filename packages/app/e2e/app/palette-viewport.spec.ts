/**
 * CommandPalette viewport-clamping (slice 07, issue #440).
 *
 * The migration from Dialog to CommandPalette dropped the
 * `height: min(calc(100vh - 16px), 512px)` clamp that Dialog provided.
 * The fix is `max-height: min(480px, calc(100dvh - 32px))` on
 * `[data-slot="palette-content"]`. This spec pins that behaviour at small
 * viewport heights so a future refactor that drops the dvh clamp will fail
 * here, not at user report time.
 */
import { test, expect } from "../fixtures"
import { openPalette } from "../actions"

test("palette content stays within viewport at 400px height", async ({ page, gotoSession }) => {
  // Resize *before* loading the session so the layout settles at the small height.
  await page.setViewportSize({ width: 1280, height: 400 })
  await gotoSession()

  // openPalette returns page.getByRole("dialog"), and Kobalte.Content
  // *is* the role="dialog" element — it carries data-slot="palette-content"
  // itself. Querying its descendants for the same slot finds nothing.
  const content = await openPalette(page)
  await expect(content).toHaveAttribute("data-slot", "palette-content")

  const box = await content.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return

  const viewport = page.viewportSize()!
  // Top + bottom edges must be inside the viewport (with a 1px tolerance
  // for sub-pixel rounding from flex centering).
  expect(box.y).toBeGreaterThanOrEqual(-1)
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1)
})

test("palette content respects the 480px ceiling at large viewport height", async ({
  page,
  gotoSession,
}) => {
  // Above the 480px ceiling — the clamp should NOT shrink the palette.
  await page.setViewportSize({ width: 1280, height: 900 })
  await gotoSession()

  // openPalette returns page.getByRole("dialog"), and Kobalte.Content
  // *is* the role="dialog" element — it carries data-slot="palette-content"
  // itself. Querying its descendants for the same slot finds nothing.
  const content = await openPalette(page)
  await expect(content).toHaveAttribute("data-slot", "palette-content")

  const box = await content.boundingBox()
  expect(box).not.toBeNull()
  if (!box) return

  // Palette is `min(480px, calc(100dvh - 32px))`; at 900px dvh that's 480px.
  // Allow a small tolerance for sub-pixel layout.
  expect(box.height).toBeLessThanOrEqual(481)
})
