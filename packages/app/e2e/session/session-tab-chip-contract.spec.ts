import { expect, test, type Page } from "../fixtures"
import { openRightPanel } from "../actions"

// Contract for the right-panel tab strip after the PR #880 chip + × cleanup.
//
// 1) Selected tab background uses `--row-active-overlay` (the same selection
//    overlay the sidebar session row uses), not the previous opaque
//    `var(--sidebar)`. Single source of truth for "this row/tab is selected"
//    across the app.
//
// 2) The × close button visual is small (~8px) — clearly subordinate to the
//    leading icon. The click slot stays at 14px to preserve a comfortable
//    hover target.
//
// 3) Leading icon and × overlap at the same horizontal center (within 1px).
//    PR #878 fixed the swap but left a 2-3px drift because CSS literals
//    (`width: 14px`, `left: 10px`) ignore that html base font-size is 13px,
//    so `size-3.5` (used by leadingSpan + closeBtn) renders ~11px instead.
//
// 4) Icon swap is instant — no opacity transition. Sweeping the mouse across
//    multiple tabs must not flash both icons during a fade.
//
// These assertions complement (don't replace) the snap grid in
// packages/app/e2e/snap/right-panel-tabs-hover.snap.ts.

const FILES_TAB = { name: "Files" }
const REVIEW_TAB = { name: "Review" }
const STATUS_TAB = { name: "Status" }

async function openExtraTabs(page: Page) {
  await page.locator("main").first().click()
  await page.keyboard.press("ControlOrMeta+\\") // fileTree.toggle
  await page.keyboard.press("ControlOrMeta+Shift+R") // review.toggle
  await expect.poll(() => page.getByRole("tab").count(), { timeout: 5_000 }).toBe(3)
}

async function ensureRightPanelOpen(page: Page) {
  await openRightPanel(page)
}

test.describe("right-panel tab chip + × contract", () => {
  test("selected tab uses --row-active-overlay (matches sidebar session row)", async ({ page, gotoSession }) => {
    await gotoSession()
    await ensureRightPanelOpen(page)
    await openExtraTabs(page)

    // Click Files so Files is selected. Then sample its computed bg.
    await page.getByRole("tab", FILES_TAB).click()
    await page.mouse.move(0, 0) // no hover; rest state

    const tokenAndComputed = await page.evaluate(() => {
      const root = document.documentElement
      const tokenRaw = getComputedStyle(root).getPropertyValue("--row-active-overlay").trim()
      const trig = document.querySelector('[data-slot="tabs-trigger"][data-value="files"]') as HTMLElement | null
      const computed = trig ? getComputedStyle(trig).backgroundColor : ""
      return { tokenRaw, computed }
    })

    // --row-active-overlay is defined as rgba(0,0,0,0.06) light / rgba(255,255,255,0.06) dark.
    // We just assert the token resolves to a low-alpha rgba (not the previous
    // opaque var(--sidebar) hex) so this test survives palette tweaks.
    expect(tokenAndComputed.tokenRaw).toMatch(/rgba?\(/)
    expect(tokenAndComputed.computed).toMatch(/rgba\(/) // not transparent, not solid hex
    const alphaMatch = tokenAndComputed.computed.match(/rgba?\([^)]*,\s*([\d.]+)\s*\)/)
    expect(alphaMatch).not.toBeNull()
    const alpha = Number(alphaMatch![1])
    expect(alpha).toBeGreaterThan(0)
    expect(alpha).toBeLessThan(0.2) // overlay band, not opaque
  })

  test("× icon visual is ~8px while click slot matches leading icon size", async ({ page, gotoSession }) => {
    await gotoSession()
    await ensureRightPanelOpen(page)
    await openExtraTabs(page)

    // Hover the Files tab so the × is rendered (opacity 1).
    await page.getByRole("tab", FILES_TAB).hover()

    const dims = await page.evaluate(() => {
      const wrap = document.querySelector('[data-slot="tabs-trigger-wrapper"][data-value="files"]')
      const slot = wrap?.querySelector('[data-slot="tabs-trigger-close-button"]') as HTMLElement | null
      const leadingSpan = wrap?.querySelector('[data-slot="tab-icon-default"]') as HTMLElement | null
      const svg = slot?.querySelector('[data-slot="icon-svg"]') as HTMLElement | null
      const box = (el: HTMLElement | null) => {
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { w: Math.round(r.width), h: Math.round(r.height) }
      }
      return { slot: box(slot), leading: box(leadingSpan), svg: box(svg) }
    })

    // Click slot must match the leading icon span. Both use `size-3.5`-aware
    // sizing now (0.875rem; ~11px under the app's rem-13 base) so swapping the
    // icon for the × keeps the same hit target and footprint.
    expect(dims.slot?.w).toBe(dims.leading?.w)
    expect(dims.slot?.h).toBe(dims.leading?.h)
    // Visible × glyph: smaller than the slot — 6 to 10px so it reads as a
    // subordinate affordance instead of overflowing the slot like the 16×16
    // leading icon does.
    expect(dims.svg?.w).toBeGreaterThanOrEqual(6)
    expect(dims.svg?.w).toBeLessThanOrEqual(10)
    expect(dims.svg?.h).toBeGreaterThanOrEqual(6)
    expect(dims.svg?.h).toBeLessThanOrEqual(10)
  })

  test("× center aligns with leading icon center (within 1px)", async ({ page, gotoSession }) => {
    await gotoSession()
    await ensureRightPanelOpen(page)
    await openExtraTabs(page)

    // Measure both elements while the wrapper is hovered. The close slot is
    // `position: absolute` and the leading icon span sits in normal flow, so
    // their CSS contracts both reference the same wrapper origin; we just need
    // a state where both are laid out (the leading span still occupies space
    // even when its opacity is 0 on hover).
    await page.getByRole("tab", FILES_TAB).hover()

    const positions = await page.evaluate(() => {
      const wrap = document.querySelector('[data-slot="tabs-trigger-wrapper"][data-value="files"]') as HTMLElement | null
      const leading = wrap?.querySelector('[data-slot="tab-icon-default"]') as HTMLElement | null
      const slot = wrap?.querySelector('[data-slot="tabs-trigger-close-button"]') as HTMLElement | null
      const box = (el: HTMLElement | null) => {
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.x, w: r.width, center: r.x + r.width / 2 }
      }
      return { leading: box(leading), slot: box(slot), wrapper: box(wrap) }
    })

    expect(positions.leading).not.toBeNull()
    expect(positions.slot).not.toBeNull()
    const diff = Math.abs(positions.leading!.center - positions.slot!.center)
    expect(diff).toBeLessThanOrEqual(1)
  })

  test("icon swap is instant (no opacity transition)", async ({ page, gotoSession }) => {
    await gotoSession()
    await ensureRightPanelOpen(page)
    await openExtraTabs(page)
    await page.mouse.move(0, 0)

    const transitions = await page.evaluate(() => {
      const wrap = document.querySelector(
        '[data-slot="tabs-trigger-wrapper"][data-value="files"]',
      ) as HTMLElement | null
      const icon = wrap?.querySelector('[data-slot="tab-icon-default"]') as HTMLElement | null
      const closeSlot = wrap?.querySelector('[data-slot="tabs-trigger-close-button"]') as HTMLElement | null
      const dur = (el: HTMLElement | null) => (el ? getComputedStyle(el).transitionDuration : null)
      return { iconDur: dur(icon), closeSlotDur: dur(closeSlot) }
    })

    // Both must be 0s — the swap is instant on hover, not faded. Multi-property
    // transitions can produce a comma-joined string like "0s, 0s"; accept any
    // shape that contains only zero durations.
    const allZero = (val: string | null) => val !== null && /^(0s\s*,?\s*)+$/.test(val.trim())
    expect(allZero(transitions.iconDur)).toBe(true)
    expect(allZero(transitions.closeSlotDur)).toBe(true)
  })

  test("Status (non-closable) shows no × on hover and keeps its icon", async ({ page, gotoSession }) => {
    // Regression guard: PR #878 had a moment where Status's icon faded under
    // a `:has(close-button-slot)` selector even though Status has no slot.
    // The current contract is: Status icon never fades, no × ever renders.
    await gotoSession()
    await ensureRightPanelOpen(page)
    await openExtraTabs(page)

    await page.getByRole("tab", STATUS_TAB).hover()
    const dims = await page.evaluate(() => {
      const wrap = document.querySelector(
        '[data-slot="tabs-trigger-wrapper"][data-value="status"]',
      ) as HTMLElement | null
      const icon = wrap?.querySelector('[data-slot="tab-icon-default"]') as HTMLElement | null
      const closeSlot = wrap?.querySelector('[data-slot="tabs-trigger-close-button"]')
      const iconOpacity = icon ? getComputedStyle(icon).opacity : null
      return { iconOpacity, hasCloseSlot: closeSlot !== null }
    })

    expect(dims.iconOpacity).toBe("1")
    expect(dims.hasCloseSlot).toBe(false)

    // Sanity: Review's wrapper still has the slot (closable peer).
    const reviewHasSlot = await page.evaluate(() =>
      document.querySelector(
        '[data-slot="tabs-trigger-wrapper"][data-value="review"] [data-slot="tabs-trigger-close-button"]',
      ) !== null,
    )
    expect(reviewHasSlot).toBe(true)
    await page.getByRole("tab", REVIEW_TAB).hover() // also closes the hover test cleanly
  })
})
