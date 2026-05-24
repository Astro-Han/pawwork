import { expect, test, type Page } from "../fixtures"
import { openRightPanel } from "../actions"
import { modKey } from "../utils"

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
  await page.keyboard.press(`${modKey}+\\`) // fileTree.toggle
  await page.keyboard.press(`${modKey}+Shift+R`) // review.toggle
  // `>= 3` not `=== 3` — Status / Files / Review are the three this spec
  // exercises, but a future default-open tab (Terminal / 上下文 / …) would
  // otherwise fail this gate before reaching the actual assertions.
  await expect.poll(() => page.getByRole("tab").count(), { timeout: 5_000 }).toBeGreaterThanOrEqual(3)
}

test.describe("right-panel tab chip + × contract", () => {
  test("selected tab uses --row-active-overlay (matches sidebar session row)", async ({ page, gotoSession }) => {
    await gotoSession()
    await openRightPanel(page)
    await openExtraTabs(page)

    // Click Files so Files is selected. Then sample its computed bg.
    await page.getByRole("tab", FILES_TAB).click()
    await page.mouse.move(0, 0) // no hover; rest state

    const tokenAndComputed = await page.evaluate(() => {
      // Resolve the active-overlay token by painting it onto a throwaway
      // element so the browser canonicalises the rgba string. Comparing the
      // raw `--row-active-overlay` value would only match if the token were
      // already in the exact `rgba(…)` form the renderer emits.
      const probe = document.createElement("div")
      probe.style.backgroundColor = "var(--row-active-overlay)"
      document.body.appendChild(probe)
      const expected = getComputedStyle(probe).backgroundColor
      probe.remove()
      // Chip background lives on the wrapper now (matches the sidebar session
      // row's chip-on-container vocabulary), not the inner trigger button.
      const wrap = document.querySelector(
        '[data-slot="tabs-trigger-wrapper"][data-value="files"]',
      ) as HTMLElement | null
      const computed = wrap ? getComputedStyle(wrap).backgroundColor : ""
      return { expected, computed }
    })

    // Exact match against the resolved `--row-active-overlay` token.
    // Replacing the token with `--row-hover-overlay` (different alpha) or
    // any other low-alpha rgba would now break this test — the previous
    // alpha-range check tolerated that silently.
    expect(tokenAndComputed.computed).toBe(tokenAndComputed.expected)
  })

  test("× glyph stays ~8px (subordinate to the 14px leading icon)", async ({ page, gotoSession }) => {
    await gotoSession()
    await openRightPanel(page)
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
    await openRightPanel(page)
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
    await openRightPanel(page)
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
    // shape that contains only zero durations. Split-and-check instead of a
    // regex with nested quantifiers to avoid CodeQL ReDoS flag (js/redos).
    const allZero = (val: string | null) =>
      val !== null && val.split(",").every((part) => part.trim() === "0s")
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
    await openRightPanel(page)
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
    await openRightPanel(page)
    await openExtraTabs(page)

    // Files is closable AND currently unselected (Status is the default).
    // Hover it; assert chip bg is the hover overlay, not transparent and not
    // the selected overlay.
    await page.getByRole("tab", FILES_TAB).hover()

    const colors = await page.evaluate(() => {
      // Resolve hover + active tokens through actual paint (same trick as
      // the selected-overlay test) so we can compare rgba strings exactly.
      const resolve = (varName: string) => {
        const probe = document.createElement("div")
        probe.style.backgroundColor = `var(${varName})`
        document.body.appendChild(probe)
        const out = getComputedStyle(probe).backgroundColor
        probe.remove()
        return out
      }
      const hoverExpected = resolve("--row-hover-overlay")
      const activeExpected = resolve("--row-active-overlay")
      // Chip backgrounds now live on the wrapper, not the trigger button.
      const wrap = document.querySelector(
        '[data-slot="tabs-trigger-wrapper"][data-value="files"]',
      ) as HTMLElement | null
      const bg = wrap ? getComputedStyle(wrap).backgroundColor : ""
      return { bg, hoverExpected, activeExpected }
    })

    // Exact-token match: hover state must paint `--row-hover-overlay`
    // verbatim, not "some other low-alpha rgba". The selected overlay is a
    // distinct token at a different alpha; swapping them silently must fail
    // here.
    expect(colors.bg).toBe(colors.hoverExpected)
    expect(colors.bg).not.toBe(colors.activeExpected)
  })

  test("short sidepanel tabs share a 72px min-width footprint", async ({ page, gotoSession }) => {
    // Status / Files / Review labels are short (2-3 Chinese chars or 5-6
    // Latin chars). Without a floor they render visibly mismatched in the
    // titlebar strip — the user's "宽度不统一难看" feedback. min-width 72px
    // covers the natural width of a 2-char CJK label + icon + gap + padding
    // (~53px) plus breathing room, so all 2-char tabs land on the same width
    // in production (Chinese labels are full-width ~13px per char, uniform).
    // Latin labels in the e2e environment (Status/Files/Review at 5-6 chars)
    // also fall under the floor and land on the same width. Longer labels
    // (Terminal at 8 chars, 上下文 at 3 CJK chars) extend past 72 naturally
    // and the strip scrolls horizontally if the total exceeds the slot width.
    await gotoSession()
    await openRightPanel(page)
    await openExtraTabs(page)
    await page.mouse.move(0, 0)

    const widths = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-slot="tabs-trigger"]')).map((trig) => ({
        value: trig.getAttribute("data-value"),
        width: Math.round(trig.getBoundingClientRect().width),
      })),
    )

    const MIN_WIDTH_PX = 72
    // In production Chinese ("状态" / "文件" / "评审" all 2 full-width CJK
    // chars) all three short tabs hit the min-width floor exactly. In the
    // e2e Latin environment "Status" (40px) and "Files" (28.6px) still fall
    // under the floor and snap to 72; "Review" (43.9px in system-ui) plus
    // icon + gap + padding adds up to ~73px, just over the floor, so it
    // renders at its natural width. Assert per-tab to lock both bands:
    //   - Status + Files: exactly 72 (the floor is the only thing keeping
    //     them uniform — drop min-width and they shrink visibly)
    //   - Review: at least 72 (it stretches naturally above the floor here,
    //     but in Chinese it lands at 72; tolerate either)
    const byValue = Object.fromEntries(widths.map((w) => [w.value, w.width]))
    expect(byValue.status).toBe(MIN_WIDTH_PX)
    expect(byValue.files).toBe(MIN_WIDTH_PX)
    expect(byValue.review).toBeGreaterThanOrEqual(MIN_WIDTH_PX)
  })

  test("closable wrapper has no trailing padding (parity with non-closable)", async ({ page, gotoSession }) => {
    // Regression guard: base tabs CSS adds `padding-right: 12px` to any
    // wrapper that owns a close-button slot. The sidepanel × is anchored on
    // top of the leading icon (anchor positioning), so trailing padding has
    // no purpose here — and leaving it in made closable wrappers (Files /
    // Review / Terminal) visibly wider than Status at the same min-width.
    // The sidepanel override resets it to 0; this test pins that.
    await gotoSession()
    await openRightPanel(page)
    await openExtraTabs(page)

    const paddings = await page.evaluate(() => {
      const wraps = Array.from(
        document.querySelectorAll<HTMLElement>('[data-slot="tabs-trigger-wrapper"]'),
      )
      return wraps.map((w) => ({
        value: w.getAttribute("data-value"),
        hasCloseSlot:
          w.querySelector('[data-slot="tabs-trigger-close-button"]') !== null,
        paddingRight: getComputedStyle(w).paddingRight,
      }))
    })

    const closable = paddings.filter((p) => p.hasCloseSlot)
    expect(closable.length).toBeGreaterThan(0)
    for (const p of closable) {
      expect(p.paddingRight).toBe("0px")
    }
  })

  test("Status (non-closable) shows no × on hover and keeps its icon", async ({ page, gotoSession }) => {
    // Regression guard: PR #878 had a moment where Status's icon faded under
    // a `:has(close-button-slot)` selector even though Status has no slot.
    // The current contract is: Status icon never fades, no × ever renders.
    await gotoSession()
    await openRightPanel(page)
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

  test("chip geometry pins to the 4pt grid (gap, padding, radius)", async ({ page, gotoSession }) => {
    // DESIGN.md L233 (4pt grid) + L305 (radius tiers sm/md/lg = 6/10/14).
    // The previous production values `gap-1.5` (6px) and `px-2.5` (10px)
    // drifted off the 4pt grid; PR #880 settled the full chip geometry:
    //   - list  gap (between chips)             : 4px (--space-xs)
    //   - trigger gap (icon ↔ label)            : 8px (--space-sm)
    //   - trigger padding-inline (chip edge)    : 4px (--space-xs)
    //   - wrapper border-radius (chip corner)   : 10px (--radius-md)
    // Pin every value so a future Tailwind/token tweak cannot quietly drift
    // any one of them off the contract.
    await gotoSession()
    await openRightPanel(page)
    await openExtraTabs(page)
    await page.mouse.move(0, 0)

    const geometry = await page.evaluate(() => {
      // Scope to the sidepanel-variant tabs (right-panel strip) — the doc
      // may host other tablists whose spacing is unrelated.
      const list = document.querySelector(
        '[data-component="tabs"][data-variant="sidepanel"] [data-slot="tabs-list"]',
      ) as HTMLElement | null
      const wrap = document.querySelector(
        '[data-slot="tabs-trigger-wrapper"][data-value="files"]',
      ) as HTMLElement | null
      const trigger = wrap?.querySelector('[data-slot="tabs-trigger"]') as HTMLElement | null
      const listCS = list ? getComputedStyle(list) : null
      const wrapCS = wrap ? getComputedStyle(wrap) : null
      const trigCS = trigger ? getComputedStyle(trigger) : null
      return {
        listGap: listCS?.columnGap ?? null,
        triggerGap: trigCS?.columnGap ?? null,
        triggerPaddingLeft: trigCS?.paddingLeft ?? null,
        triggerPaddingRight: trigCS?.paddingRight ?? null,
        wrapperBorderRadius: wrapCS?.borderTopLeftRadius ?? null,
      }
    })

    expect(geometry.listGap).toBe("4px")
    expect(geometry.triggerGap).toBe("8px")
    expect(geometry.triggerPaddingLeft).toBe("4px")
    expect(geometry.triggerPaddingRight).toBe("4px")
    expect(geometry.wrapperBorderRadius).toBe("10px")
  })
})
