import { expect, test } from "../fixtures"
import { openRightPanel } from "../actions"
import { modKey } from "../utils"

// Contract for the titlebar's right rail — the flex row inside the titlebar's
// rightmost grid column that hosts:
//   1. `#pawwork-titlebar-right`  → the right utility panel toggle (or
//                                   StatusPopover fallback on non-session routes)
//   2. `#pawwork-titlebar-tabs`   → the right-panel tab strip portal target
//
// PR #880 moved the tab strip from absolute overlay to an in-flow flex sibling
// of the toggle so the two own disjoint geometry (no pointer-events
// choreography needed). These tests guard the load-bearing properties of that
// new layout — properties that are easy to silently break by dropping a
// `self-stretch`, re-introducing absolute positioning on the slot, or
// forgetting to grow the toggle area when the tab set grows.
//
// Sibling specs:
//   - session-tab-chip-contract.spec.ts — chip visuals & geometry (×, hover,
//     selection overlay, 4pt grid pinning)

test.describe("titlebar right rail contract", () => {
  test("right utility toggle stays clickable with the full tab set open", async ({
    page,
    gotoSession,
  }) => {
    // Regression guard: PR #878 had the titlebar tabs slot absolute-positioned
    // over `#pawwork-titlebar-right`, relying on `pointer-events-none` /
    // `-auto` choreography to keep the toggle clickable through the overlay.
    // That broke at 4+ tabs because the `+` button got pushed into the
    // toggle's x range and `pointer-events: auto` (required for the `+`
    // dropdown to open) intercepted clicks meant for the toggle.
    // Fix: the tabs slot is now an in-flow flex sibling of the toggle inside
    // the titlebar's right rail (see `Titlebar` comments) — disjoint
    // geometry, no overlay, no click choreography. This test opens the full
    // default-reachable tab set so any future regression that reintroduces
    // overlap (e.g. re-absolutising the slot, growing toggle into the rail)
    // fails fast.
    await gotoSession()
    await openRightPanel(page)
    // Open the maximum default-reachable tab set so the strip is widest.
    await page.locator("main").first().click()
    await page.keyboard.press(`${modKey}+\\`) // fileTree.toggle → Files
    await page.keyboard.press(`${modKey}+Shift+R`) // review.toggle → Review
    await page.keyboard.press("Control+`") // terminal.toggle → Terminal (always Ctrl)
    await page.mouse.move(0, 0)

    const toggle = page.getByRole("button", { name: "Right utility panel" })
    await expect(toggle).toHaveAttribute("aria-expanded", "true")
    // If anything in the tabs-portal overlay swallows the click, this
    // times out with "subtree intercepts pointer events".
    await toggle.click({ timeout: 3_000 })
    await expect(toggle).toHaveAttribute("aria-expanded", "false", { timeout: 2_000 })
  })

  test("tabs slot shrinks to 0 width when viewport drops below the desktop breakpoint", async ({
    page,
    gotoSession,
  }) => {
    // Regression guard from PR #880 followup review: `SessionSidePanel` gates
    // its render on `createMediaQuery("(min-width: 768px)")`, but
    // `--right-panel-width` and the titlebar's `tabsRailActive` only check
    // `layout.rightPanel.opened()`. Without an explicit viewport gate, opening
    // the panel at desktop width and then shrinking the viewport below 768px
    // would leave the titlebar reserving panel-width of empty rail (no portal
    // mounts under the breakpoint), pushing the right utility toggle off the
    // viewport edge with nothing visible to justify the gap.
    await gotoSession()
    await openRightPanel(page)
    // Sanity: rail occupies panel-width while we're still desktop.
    const desktopTabsWidth = await page
      .locator("#pawwork-titlebar-tabs")
      .evaluate((el) => Math.round(el.getBoundingClientRect().width))
    expect(desktopTabsWidth).toBeGreaterThan(0)

    await page.setViewportSize({ width: 600, height: 900 })

    // Poll until layout settles — viewport resize → media query → Solid memo →
    // DOM update isn't synchronous, and reading geometry on the same tick that
    // `setViewportSize` resolves can race the transition.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const tabs = document.getElementById("pawwork-titlebar-tabs") as HTMLElement | null
            const cs = tabs ? getComputedStyle(tabs) : null
            return {
              width: tabs ? Math.round(tabs.getBoundingClientRect().width) : null,
              // `border-l` should be gone — no stray 1px line in a 0-width slot.
              borderLeft: cs?.borderLeftWidth ?? null,
            }
          }),
        { timeout: 2_000 },
      )
      .toEqual({ width: 0, borderLeft: "0px" })
  })

  test("tabs slot border-l spans the full titlebar height (no top/bottom seam break)", async ({
    page,
    gotoSession,
  }) => {
    // Regression guard from PR #880 followup review: with the tabs slot moved
    // from absolute overlay to an in-flow flex sibling, its `self-stretch` only
    // matches the parent flex container's content height. The titlebar root
    // uses `items-center` (grid), which lets each grid cell collapse to its
    // child's content box unless the cell opts out with `self-stretch` / `h-full`.
    // If the right rail isn't full-height, the tabs slot's `border-l` also
    // isn't full-height — it would visibly break above and below the toggle's
    // 30px row, and stop meeting the right-panel body's `border-l` directly
    // below the titlebar. This test pins the slot's painted height to the
    // titlebar's own height so any future regression that drops the
    // stretch chain fails fast.
    await gotoSession()
    await openRightPanel(page)
    await page.mouse.move(0, 0)

    const heights = await page.evaluate(() => {
      const titlebar = document.querySelector('[data-component="titlebar-shell"]') as HTMLElement | null
      const tabs = document.getElementById("pawwork-titlebar-tabs") as HTMLElement | null
      return {
        titlebar: titlebar ? Math.round(titlebar.getBoundingClientRect().height) : null,
        tabs: tabs ? Math.round(tabs.getBoundingClientRect().height) : null,
      }
    })

    expect(heights.titlebar).not.toBeNull()
    expect(heights.tabs).not.toBeNull()
    expect(heights.tabs).toBe(heights.titlebar)
  })
})
