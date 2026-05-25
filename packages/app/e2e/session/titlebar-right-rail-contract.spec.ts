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
  test("expanded titlebar toggles change icon shape without selected-chip background", async ({
    page,
    gotoSession,
  }) => {
    await gotoSession()

    const sidebarToggle = page.locator('[data-action="pawwork-sidebar-toggle"]')
    const rightPanelToggle = page.getByRole("button", { name: "Right utility panel" })
    if ((await sidebarToggle.getAttribute("aria-expanded")) !== "true") {
      await sidebarToggle.click()
    }
    await expect(sidebarToggle).toHaveAttribute("aria-expanded", "true")
    await openRightPanel(page)
    await expect(rightPanelToggle).toHaveAttribute("aria-expanded", "true")
    await page.mouse.move(400, 200)

    const backgroundAlpha = (selector: string) =>
      page.evaluate((target) => {
        const el = document.querySelector<HTMLElement>(target)
        if (!el) return null
        const bg = getComputedStyle(el).backgroundColor
        const rgba = bg.match(/^rgba\((.+)\)$/)
        if (!rgba) return bg.startsWith("rgb(") ? 1 : null
        const parts = rgba[1].split(",").map((part) => part.trim())
        return Number(parts[3])
      }, selector)

    await expect
      .poll(
        async () => ({
          sidebar: await backgroundAlpha('[data-action="pawwork-sidebar-toggle"]'),
          rightPanel: await backgroundAlpha('button[aria-label="Right utility panel"]'),
        }),
        { timeout: 2_000 },
      )
      .toEqual({
        sidebar: 0,
        rightPanel: 0,
      })

    await sidebarToggle.hover()
    await expect.poll(() => backgroundAlpha('[data-action="pawwork-sidebar-toggle"]')).toBeGreaterThan(0)

    await rightPanelToggle.hover()
    await expect.poll(() => backgroundAlpha('button[aria-label="Right utility panel"]')).toBeGreaterThan(0)
  })

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

  test("tabs slot border-l aligns horizontally with the right-panel body border-l (no x-axis seam break)", async ({
    page,
    gotoSession,
  }) => {
    // Regression guard for the post-release seam reported after PR #880:
    // the macOS titlebar-shell carried a symmetric `padding-inline: 8px`,
    // which pushed the tabs slot's right edge 8px inboard of the viewport.
    // The right-panel `<aside>` directly below sits in a sibling layout
    // tree without that padding, so its `border-left` reached the viewport
    // edge — the two `border-l`s ended up offset by 8px on macOS only.
    // Fix: macOS titlebar uses `padding-inline-start: 8px` only (see
    // `packages/app/src/index.css` `[data-shell-os="macos"]` rule). This
    // test asserts the horizontal seam is continuous so any future
    // re-introduction of right-side titlebar padding (or any other
    // x-offset between the two `border-l`s) fails fast.
    await gotoSession()
    await openRightPanel(page)
    await page.mouse.move(0, 0)

    // Poll for steady state instead of reading immediately: the panel
    // `<aside>` width and shell `--right-panel-width` both transition over
    // 240ms (CSS width transition vs @property var transition) and the
    // `data-resizing-right-panel` snap-gate only fires during drag-resize,
    // not panel open/close. Reading mid-flight can hit transient sub-pixel
    // drift between the two interpolators and bust the <1px tolerance.
    // Sub-pixel tolerance at steady state — both use the same panel-width
    // source, so they should be identical at integer-CSS-pixel widths,
    // but devicePixelRatio rounding can introduce ≤0.5px noise on Retina.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const tabs = document.getElementById("pawwork-titlebar-tabs")
            const body = document.querySelector('[data-component="right-panel-body"]')
            if (!tabs || !body) return null
            return Math.abs(tabs.getBoundingClientRect().left - body.getBoundingClientRect().left)
          }),
        { timeout: 2_000 },
      )
      .toBeLessThan(1)
  })

  test("right utility toggle keeps the same x-position across open/close", async ({
    page,
    gotoSession,
  }) => {
    // Regression guard from the post-#887 design discussion: PR #880's
    // structural layout (toggle as a flex sibling of the tabs slot) made
    // the toggle slide left by `--right-panel-width` whenever the panel
    // opened, which the maintainer reported as visually jarring once the
    // alignment seam was fixed and the motion became visible. The fix
    // keeps the toggle in `#pawwork-titlebar-right` (still rendered by
    // `SessionHeader` via Portal) but makes that container absolute-
    // positioned to the rail's top-right corner — so the same DOM node
    // sits at the same viewport-pixel `right` across open and closed
    // states. This test pins that contract.
    await gotoSession()
    await page.mouse.move(0, 0)

    const toggleRight = () =>
      page.evaluate(() => {
        const btn = document.querySelector<HTMLElement>(
          'button[aria-label="Right utility panel"]',
        )
        return btn ? btn.getBoundingClientRect().right : null
      })

    // Normalize to closed before sampling — the e2e harness defaults to
    // closed today, but persisting that as a fixture assumption is fragile
    // (a future session-fixture or persisted-layout shift would flip it
    // and the test would silently measure "open" twice). aria-expanded is
    // the source of truth.
    const toggleButton = page.locator('button[aria-label="Right utility panel"]')
    if ((await toggleButton.getAttribute("aria-expanded")) === "true") {
      await toggleButton.click()
      await expect(toggleButton).toHaveAttribute("aria-expanded", "false")
    }
    const closed = await toggleRight()
    expect(closed).not.toBeNull()

    // Open the panel via the toggle itself.
    await toggleButton.click()
    // Wait for `open()` to flip — aria-expanded reflects the source of truth.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const btn = document.querySelector<HTMLElement>(
              'button[aria-label="Right utility panel"]',
            )
            return btn?.getAttribute("aria-expanded") ?? null
          }),
        { timeout: 2_000 },
      )
      .toBe("true")
    // Poll until the toggle's right edge is stable (two consecutive reads
    // match within sub-pixel rounding). The slot's 240ms width transition
    // doesn't move the toggle (it's absolute-positioned to the rail), but
    // reading mid-paint can hit transient values; polling for stability
    // beats a fixed `waitForTimeout` that's either too short or wasteful.
    let prev: number | null = null
    await expect
      .poll(
        async () => {
          const current = await toggleRight()
          const stable = prev !== null && current !== null && Math.abs(current - prev) < 1
          prev = current
          return stable
        },
        { timeout: 2_000, intervals: [50, 80, 120, 200] },
      )
      .toBe(true)

    const open = await toggleRight()
    expect(open).not.toBeNull()

    // Same DOM node, absolute-positioned to the same `right` inset in both
    // states — should be pixel-identical within sub-pixel rounding noise
    // (Retina devicePixelRatio 2x can introduce ≤0.5px deltas).
    expect(Math.abs((open ?? 0) - (closed ?? 0))).toBeLessThan(1)
  })

  test('"+" add-tab button stays clickable and does not close the panel (no toggle overlap)', async ({
    page,
    gotoSession,
  }) => {
    // Regression guard for the P1 risk raised in code review of #887:
    // the right utility toggle is absolute-positioned over the rightmost
    // area of the tabs slot, and the `+` (add-tab DropdownMenu trigger)
    // lives inside the portalled Tabs.List. If `+` ever slides under the
    // toggle's hit-target (e.g. Tabs.List grows to fill the slot, or the
    // slot's right-reserve gets removed), clicks meant for `+` would be
    // intercepted by the toggle — opening the dropdown would instead
    // close the panel. This test asserts the user-visible contract:
    // clicking `+` opens its menu AND the panel stays open.
    await gotoSession()
    await openRightPanel(page)
    await page.mouse.move(0, 0)
    // Let the open animation settle so the slot is at resting width
    // and the `+` button is at its final position.
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const btn = document.querySelector<HTMLElement>(
              'button[aria-label="Right utility panel"]',
            )
            return btn?.getAttribute("aria-expanded") ?? null
          }),
        { timeout: 2_000 },
      )
      .toBe("true")

    // Click the `+` add-tab trigger. If the toggle's hit-target covers it,
    // this click triggers the toggle instead and aria-expanded flips false.
    await page.getByRole("button", { name: "Add tab" }).click()

    // Contract 1: panel stays open. Use a raw selector instead of
    // `getByRole` because the open DropdownMenu makes the rest of the page
    // inert/aria-hidden, which `getByRole` filters out.
    await expect(
      page.locator('button[aria-label="Right utility panel"]'),
    ).toHaveAttribute("aria-expanded", "true")
    // Contract 2: the dropdown menu actually opened. Solid-ui's DropdownMenu
    // renders content in a portal with role="menu".
    await expect(page.getByRole("menu")).toBeVisible({ timeout: 2_000 })
  })

  test('"+" stays clickable even if Tabs.List is forced to fill the slot (collision guard)', async ({
    page,
    gotoSession,
  }) => {
    // Fortification test for the same P1 risk: the no-collision guarantee
    // in production today depends on Kobalte's `Tabs.List` rendering at
    // content-width. If a future change makes the list fill the slot, the
    // `+` button would slide to the slot's right edge. The titlebar slot
    // reserves a 44px right padding to make that case safe; this test
    // injects the future scenario (`width: 100% !important` on
    // `[data-slot="tabs-list"]`) and asserts the contract still holds.
    await gotoSession()
    await openRightPanel(page)

    // Force the "future" layout: Tabs.List fills the slot.
    await page.addStyleTag({
      content: `
        #pawwork-titlebar-tabs [data-slot="tabs-list"] {
          width: 100% !important;
          flex-grow: 1 !important;
        }
      `,
    })

    await page.mouse.move(0, 0)
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const btn = document.querySelector<HTMLElement>(
              'button[aria-label="Right utility panel"]',
            )
            return btn?.getAttribute("aria-expanded") ?? null
          }),
        { timeout: 2_000 },
      )
      .toBe("true")

    // Geometry check: `+` button's right edge must stop before the toggle's
    // left edge — i.e. the slot's padding-end reserve actually keeps them
    // apart even with Tabs.List filling the slot.
    const geom = await page.evaluate(() => {
      const plus = document.querySelector<HTMLElement>('button[aria-label="Add tab"]')
      const toggle = document.querySelector<HTMLElement>(
        'button[aria-label="Right utility panel"]',
      )
      return {
        plusRight: plus?.getBoundingClientRect().right ?? null,
        toggleLeft: toggle?.getBoundingClientRect().left ?? null,
      }
    })
    expect(geom.plusRight).not.toBeNull()
    expect(geom.toggleLeft).not.toBeNull()
    expect(geom.plusRight!).toBeLessThan(geom.toggleLeft!)

    // Behavioral check: `+` still actually opens its dropdown without
    // closing the panel — geometry alone could be misleading if some
    // hit-test layer intercepts.
    await page.getByRole("button", { name: "Add tab" }).click()
    await expect(
      page.locator('button[aria-label="Right utility panel"]'),
    ).toHaveAttribute("aria-expanded", "true")
    await expect(page.getByRole("menu")).toBeVisible({ timeout: 2_000 })
  })

  test("data-resizing-right-panel attribute does not leak when viewport drops below the desktop breakpoint mid-resize state", async ({
    page,
    gotoSession,
  }) => {
    // Regression guard from review of #887: the sizing effect mirrors
    // `props.size.active()` to a `data-resizing-right-panel` attribute on
    // `<desktop-shell>`, which a `!important` CSS rule reads to suppress
    // the shell's transition. If the effect leaves the attribute set
    // (early-return on breakpoint flip without cleanup, or component
    // unmount with active=true), the shell's `--right-panel-width` and
    // `--sidebar-width` transitions stay disabled across the whole
    // session — sidebar/right-panel open/close animations silently die.
    //
    // We simulate the leak path by setting the attribute via DOM directly
    // (mimicking an in-progress drag), then triggering the breakpoint flip
    // that previously hit the unguarded `early return`, and assert the
    // attribute is gone — proving the effect re-runs cleanup correctly.
    await gotoSession()
    await openRightPanel(page)

    // Pre-condition: the attribute is absent at rest.
    await expect.poll(
      () =>
        page.evaluate(() =>
          document
            .querySelector('[data-component="desktop-shell"]')
            ?.hasAttribute("data-resizing-right-panel"),
        ),
      { timeout: 2_000 },
    ).toBe(false)

    // Force the attribute on (simulates "drag is active").
    await page.evaluate(() => {
      document
        .querySelector('[data-component="desktop-shell"]')
        ?.setAttribute("data-resizing-right-panel", "")
    })

    // Now flip the breakpoint — viewport shrinks below 768px. The sizing
    // effect must re-run, hit its "always-clear" step, and remove the
    // attribute even though `isDesktop()` will then early-return.
    await page.setViewportSize({ width: 600, height: 900 })

    // Attribute should be gone within a tick or two of the breakpoint flip.
    await expect.poll(
      () =>
        page.evaluate(() =>
          document
            .querySelector('[data-component="desktop-shell"]')
            ?.hasAttribute("data-resizing-right-panel"),
        ),
      { timeout: 2_000 },
    ).toBe(false)
  })
})
