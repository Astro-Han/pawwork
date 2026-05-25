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

  test("Solid Portal wrapper fills the slot so Tabs.List can bound overflow scroll", async ({
    page,
    gotoSession,
  }) => {
    // Regression guard: <Portal> from solid-js/web creates an intermediate
    // <div> between the mount target and its children (see
    // node_modules/solid-js/web/dist/web.js → Portal(): document.createElement('div')
    // appendChild'd to el). Without an explicit size rule, that wrapper is
    // display:block and content-sized, so Tabs.List's `width: 100%` (from
    // tabs.css base + sidepanel variant) resolves against the wrapper rather
    // than the slot — and `overflow-x: auto` on the list never bounds
    // anything. Terminal chips then overflow the slot silently (the slot
    // itself uses `overflow: clip` from the same base rule).
    //
    // The fix lives in tabs.css sidepanel variant: `& > div { width: 100%;
    // height: 100%; min-width: 0; display: flex; }`. This test asserts the
    // wrapper actually fills the slot's content-box, plus the existing
    // contract that `+` does not collide with the panel toggle.
    //
    // An earlier version of this test injected `width: 100% !important` on
    // [data-slot="tabs-list"] directly, which bypassed the Portal wrapper
    // and so passed even when the production bug was live — false coverage.
    await gotoSession()
    await openRightPanel(page)
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

    // Wrapper-fills-slot check: Solid's Portal mounts a single <div>
    // child into `#pawwork-titlebar-tabs`. Its border-box width must equal
    // the slot's inner content width (slot width minus padding-right reserve
    // for the toggle). Without this, the list reports content-width and
    // overflow-x cannot trigger.
    const layout = await page.evaluate(() => {
      const slot = document.querySelector<HTMLElement>("#pawwork-titlebar-tabs")
      const wrapper = slot?.firstElementChild as HTMLElement | null
      if (!slot || !wrapper) return null
      const slotRect = slot.getBoundingClientRect()
      const cs = getComputedStyle(slot)
      const paddingRight = parseFloat(cs.paddingRight || "0")
      return {
        wrapperWidth: wrapper.getBoundingClientRect().width,
        slotInnerWidth: slotRect.width - paddingRight,
      }
    })
    expect(layout).not.toBeNull()
    // Allow 1px rounding tolerance.
    expect(Math.abs(layout!.wrapperWidth - layout!.slotInnerWidth)).toBeLessThan(2)

    // Scope guard: the Portal-wrapper fix must NOT leak into the right-panel
    // body's <Tabs variant="sidepanel"> host. That host also has
    // data-component="tabs" + data-variant="sidepanel", but no
    // data-shell-slot="tabs-portal" — so an earlier wider selector
    // ([data-variant="sidepanel"] > div) accidentally forced display:flex /
    // height:100% on every Tabs.Content panel underneath, changing chip
    // shape and selection visuals as a side effect. This assertion locks
    // the rule down to the titlebar slot only by verifying the body's
    // Tabs.Content has its natural (non-flex) display.
    const bodyContentDisplay = await page.evaluate(() => {
      const bodyTabs = document.querySelector<HTMLElement>(
        '[data-component="right-panel-body"] [data-component="tabs"][data-variant="sidepanel"]',
      )
      const firstContent = bodyTabs?.querySelector<HTMLElement>('[data-slot="tabs-content"]')
      return firstContent ? getComputedStyle(firstContent).display : null
    })
    expect(bodyContentDisplay).not.toBeNull()
    expect(bodyContentDisplay).not.toBe("flex")

    // Geometry check (preserved from the previous collision-guard test): the
    // `+` button's right edge must stop before the toggle's left edge — the
    // slot's 44px padding-right reserve keeps them apart.
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
    // closing the panel.
    await page.getByRole("button", { name: "Add tab" }).click()
    await expect(
      page.locator('button[aria-label="Right utility panel"]'),
    ).toHaveAttribute("aria-expanded", "true")
    await expect(page.getByRole("menu")).toBeVisible({ timeout: 2_000 })
  })

  test("closing a chip preserves sibling chip DOM identity (For keys by stable id, not fresh object refs)", async ({
    page,
    gotoSession,
  }) => {
    // Regression guard: `shellTabs` memo (session-side-panel.tsx:137) returns
    // a fresh array of fresh objects on every recompute via `.map(...)`.
    // SolidJS `<For>` (right-panel-tab-strip.tsx:82) keys by reference
    // identity — fresh refs cause every chip to unmount and remount, not
    // just the one that changed. Each SortableShellTab's createSortable
    // (solid-dnd) registers/removes a `sortableOffset` transformer on its
    // droppable; the all-remount cascade thrashes that registry and (in
    // dev build) emits multiple "Cannot remove from droppable" warnings.
    //
    // The directly observable symptom is DOM node churn: a sibling chip's
    // <div data-slot="tabs-trigger-wrapper"> element is REPLACED, not
    // preserved, on every state change. This is build-agnostic — works
    // regardless of whether the test runner pulls solid-dnd's dev or prod
    // build. After the fix (For keyed by stable string ids), sibling chip
    // nodes are the same DOM reference across the close.
    await gotoSession()
    await openRightPanel(page)
    // Open Files and Review so the strip has two sortable sibling chips.
    await page.locator("main").first().click()
    await page.keyboard.press(`${modKey}+\\`) // Files
    await page.keyboard.press(`${modKey}+Shift+R`) // Review
    await page.mouse.move(0, 0)

    await expect(
      page.locator('[data-slot="tabs-trigger-wrapper"][data-value="files"]'),
    ).toBeVisible()
    await expect(
      page.locator('[data-slot="tabs-trigger-wrapper"][data-value="review"]'),
    ).toBeVisible()

    // Stash the Review chip's DOM node before we close Files.
    await page.evaluate(() => {
      const review = document.querySelector(
        '[data-slot="tabs-trigger-wrapper"][data-value="review"]',
      )
      ;(window as unknown as { __reviewChipBefore: Element | null }).__reviewChipBefore =
        review
    })

    // Close Files via its × button.
    await page
      .locator('[data-slot="tabs-trigger-wrapper"][data-value="files"]')
      .hover()
    await page
      .locator(
        '[data-slot="tabs-trigger-wrapper"][data-value="files"] button[aria-label*="Close"]',
      )
      .click()

    // Wait for the close to settle.
    await expect(
      page.locator('[data-slot="tabs-trigger-wrapper"][data-value="files"]'),
    ).toHaveCount(0)
    await expect(
      page.locator('[data-slot="tabs-trigger-wrapper"][data-value="review"]'),
    ).toBeVisible()

    // Assert Review's DOM node is the SAME element (For reused it).
    const reviewNodePreserved = await page.evaluate(() => {
      const review = document.querySelector(
        '[data-slot="tabs-trigger-wrapper"][data-value="review"]',
      )
      const before = (window as unknown as { __reviewChipBefore: Element | null })
        .__reviewChipBefore
      return review === before
    })
    expect(reviewNodePreserved).toBe(true)
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
