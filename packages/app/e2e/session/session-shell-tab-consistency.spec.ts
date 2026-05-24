import { test, expect } from "../fixtures"
import { openRightPanel, rightPanelTabList } from "../actions"

// Right-panel shell tabs (Status / Files / Review) live in the titlebar slot
// portalled from <SessionSidePanel>. DESIGN.md and the sidepanel comment in
// `packages/ui/src/components/tabs.css` both spell out the active marker:
// "weight + color shift only. No chip background." If a higher-specificity
// rule paints a background on the selected trigger, only that one tab gets
// a chip and the row reads as visually inconsistent (Status looks wider
// than Files / Review).
//
// This test asserts the contract at the rendered seam — computed backgroundColor
// of all three triggers must agree. Source-text CSS asserts are too far from
// the cascade to catch app-level overrides from packages/app/src/index.css.
test("right-panel shell tab triggers share the same background color (no selected chip)", async ({
  page,
  gotoSession,
}) => {
  await gotoSession()
  await openRightPanel(page)

  // Open Files + Review via their registered shortcuts (same approach as
  // right-panel-titlebar.snap.ts; the "+" dropdown in the titlebar slot has
  // a hit-test edge case).
  await page.locator("main").first().click()
  await page.keyboard.press("ControlOrMeta+\\")
  await page.keyboard.press("ControlOrMeta+Shift+R")

  const tablist = rightPanelTabList(page)
  await expect(tablist.getByRole("tab")).toHaveCount(3)

  // Status is the default landing tab; click it explicitly so the snapshot is
  // deterministic regardless of which shortcut fired last.
  await tablist.getByRole("tab", { name: "Status" }).click()
  // Move pointer away so :hover is not on any trigger.
  await page.mouse.move(0, 0)

  const bgs = await page.evaluate(() => {
    return ["status", "files", "review"].map((value) => {
      const trigger = document.querySelector(
        `[data-value="${value}"][data-slot="tabs-trigger"]`,
      ) as HTMLElement | null
      return trigger ? getComputedStyle(trigger).backgroundColor : null
    })
  })

  // All three must agree. Don't hard-code the expected color — the contract
  // is "same as each other", not "specifically transparent" (a future design
  // may give every tab a base bg). What matters is no single one stands out.
  expect(bgs[0]).not.toBeNull()
  expect(bgs[0]).toBe(bgs[1])
  expect(bgs[1]).toBe(bgs[2])
})
