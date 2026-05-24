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
      // Chip background lives on the wrapper now (matches the sidebar session
      // row's chip-on-container vocabulary), not the inner trigger button.
      const wrap = document.querySelector(
        '[data-slot="tabs-trigger-wrapper"][data-value="files"]',
      ) as HTMLElement | null
      const computed = wrap ? getComputedStyle(wrap).backgroundColor : ""
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

  test("× glyph stays ~8px (subordinate to the 14px leading icon)", async ({ page, gotoSession }) => {
    await gotoSession()
    await ensureRightPanelOpen(page)
    await openExtraTabs(page)

    // Hover the Files tab so the × is rendered (opacity 1).
    await page.getByRole("tab", FILES_TAB).hover()

    const dims = await page.evaluate(() => {
      const wrap = document.querySelector('[data-slot="tabs-trigger-wrapper"][data-value="files"]')
      const slot = wrap?.querySelector('[data-slot="tabs-trigger-close-button"]') as HTMLElement | null
      const svg = slot?.querySelector('[data-slot="icon-svg"]') as HTMLElement | null
      const box = (el: HTMLElement | null) => {
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { w: Math.round(r.width), h: Math.round(r.height) }
      }
      return { svg: box(svg) }
    })

    // Visible × glyph: 6 to 10px so it reads as a subordinate affordance
    // instead of overflowing the cell like the 16×16 raw leading icon does.
    expect(dims.svg?.w).toBeGreaterThanOrEqual(6)
    expect(dims.svg?.w).toBeLessThanOrEqual(10)
    expect(dims.svg?.h).toBeGreaterThanOrEqual(6)
    expect(dims.svg?.h).toBeLessThanOrEqual(10)
  })

  test("× center aligns with leading icon center (within 1px)", async ({ page, gotoSession }) => {
    await gotoSession()
    await ensureRightPanelOpen(page)
    await openExtraTabs(page)

    // After the grid overlay refactor: the close-button slot is a full-cell
    // flex container that pushes the × button to the same
    // `padding-inline-start` the trigger uses for its leading icon. Measure
    // the × icon-button (the actual visible glyph holder), not the slot box,
    // against the leading icon span.
    await page.getByRole("tab", FILES_TAB).hover()

    const positions = await page.evaluate(() => {
      const wrap = document.querySelector('[data-slot="tabs-trigger-wrapper"][data-value="files"]') as HTMLElement | null
      const leading = wrap?.querySelector('[data-slot="tab-icon-default"]') as HTMLElement | null
      const closeBtn = wrap?.querySelector('[data-slot="tabs-trigger-close-button"] [data-component="icon-button"]') as HTMLElement | null
      const box = (el: HTMLElement | null) => {
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.x, w: r.width, center: r.x + r.width / 2 }
      }
      return { leading: box(leading), close: box(closeBtn) }
    })

    expect(positions.leading).not.toBeNull()
    expect(positions.close).not.toBeNull()
    const diff = Math.abs(positions.leading!.center - positions.close!.center)
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

  test("selected closable tab with mouse parked away shows leading icon, not ×", async ({
    page,
    gotoSession,
  }) => {
    // Regression for the "leading icon + × both visible" state. PR #878 left a
    // base-level rule:
    //
    //   [data-component="tabs"] [data-slot="tabs-trigger-wrapper"]:has([data-selected])
    //     [data-slot="tabs-trigger-close-button"] { opacity: 1 }
    //
    // That outranks the sidepanel slot's `opacity: 0` rest state (3 attrs vs 4),
    // so every selected closable tab forced the × on regardless of hover. The
    // user saw the × layered on top of the leading icon whenever they clicked
    // a tab and moved the cursor away.
    await gotoSession()
    await ensureRightPanelOpen(page)
    await openExtraTabs(page)

    // Select Files (closable), then park the cursor far off the tab strip so
    // neither :hover nor the swap rules fire.
    await page.getByRole("tab", FILES_TAB).click()
    await page.mouse.move(10, 700)

    const state = await page.evaluate(() => {
      const wrap = document.querySelector(
        '[data-slot="tabs-trigger-wrapper"][data-value="files"]',
      ) as HTMLElement | null
      const leading = wrap?.querySelector('[data-slot="tab-icon-default"]') as HTMLElement | null
      const slot = wrap?.querySelector('[data-slot="tabs-trigger-close-button"]') as HTMLElement | null
      return {
        leadingOpacity: leading ? getComputedStyle(leading).opacity : null,
        closeOpacity: slot ? getComputedStyle(slot).opacity : null,
        selected:
          wrap?.querySelector('[data-slot="tabs-trigger"][data-selected]') !== null,
      }
    })

    expect(state.selected).toBe(true)
    expect(state.leadingOpacity).toBe("1")
    expect(state.closeOpacity).toBe("0")
  })

  test("hover paints a chip preview (--row-hover-overlay), selected wins", async ({
    page,
    gotoSession,
  }) => {
    // Hover should preview the selection with a lighter overlay than the
    // selected state — matches the sidebar session row's two-tier vocabulary
    // (--row-hover-overlay 4%, --row-active-overlay 6%). Without this rule the
    // titlebar tab strip felt dead on hover and clicks landed without any
    // visual lead-in, which the user flagged as poor UX.
    await gotoSession()
    await ensureRightPanelOpen(page)
    await openExtraTabs(page)

    // Files is closable AND currently unselected (Status is the default).
    // Hover it; assert chip bg is the hover overlay, not transparent and not
    // the selected overlay.
    await page.getByRole("tab", FILES_TAB).hover()

    const colors = await page.evaluate(() => {
      const root = document.documentElement
      const hoverToken = getComputedStyle(root).getPropertyValue("--row-hover-overlay").trim()
      const activeToken = getComputedStyle(root).getPropertyValue("--row-active-overlay").trim()
      // Chip backgrounds now live on the wrapper, not the trigger button.
      const wrap = document.querySelector(
        '[data-slot="tabs-trigger-wrapper"][data-value="files"]',
      ) as HTMLElement | null
      const bg = wrap ? getComputedStyle(wrap).backgroundColor : ""
      return { bg, hoverToken, activeToken }
    })

    const alpha = (rgba: string) => {
      const m = rgba.match(/rgba?\([^)]*,\s*([\d.]+)\s*\)/)
      return m ? Number(m[1]) : NaN
    }
    // Hover paints SOME overlay (alpha between 0 and the active value).
    expect(colors.bg).toMatch(/rgba\(/)
    const bgAlpha = alpha(colors.bg)
    expect(bgAlpha).toBeGreaterThan(0)
    expect(bgAlpha).toBeLessThanOrEqual(alpha(colors.activeToken))
  })

  test("short sidepanel tabs share a 5.5rem min-width footprint", async ({ page, gotoSession }) => {
    // Status / Files / Review labels are short (2-3 Chinese chars or 5-6
    // Latin chars). Without a floor they render visibly mismatched in the
    // titlebar strip — the user's "宽度不统一难看" feedback. min-width 5.5rem
    // (~71.5px at the 13px html base) pulls short chips up to a uniform
    // footprint; longer labels (Terminal at 8 Latin chars) extend past it
    // naturally and the strip scrolls horizontally if the total exceeds the
    // slot width. The 5.5rem floor is sized to fit "Files" + icon + padding
    // without dwarfing it, which the earlier 7.5rem attempt did.
    await gotoSession()
    await ensureRightPanelOpen(page)
    await openExtraTabs(page)
    await page.mouse.move(0, 0)

    const widths = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-slot="tabs-trigger"]')).map((trig) => ({
        value: trig.getAttribute("data-value"),
        width: Math.round(trig.getBoundingClientRect().width),
      })),
    )

    const MIN_WIDTH_PX = Math.round(5.5 * 13) // ~72
    expect(widths.length).toBeGreaterThanOrEqual(3)
    for (const t of widths) {
      expect(t.width).toBeGreaterThanOrEqual(MIN_WIDTH_PX - 1) // -1 for rounding
    }
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
