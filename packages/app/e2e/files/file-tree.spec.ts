import { test, expect } from "../fixtures"
import { openRightPanel, withSession } from "../actions"

// Historical context: before the right-panel-polish PR (#52), the Review tab
// carried a sibling vertical file-tree pane (#file-tree-panel) that surfaced
// a full workspace tree next to the diff viewer. That pane was removed by
// design so the diff viewer can claim the full Review pane width. This spec
// now guards the inverse invariant: the pane must NOT render, and the Review
// tab content area must still mount.
test("@smoke review tab no longer renders the legacy file-tree sub-panel", async ({ page, project }) => {
  await project.open()

  await withSession(project.sdk, `e2e review layout smoke ${Date.now()}`, async (session) => {
    await project.gotoSession(session.id)

    const rightPanel = await openRightPanel(page)
    const shellTabList = rightPanel.getByRole("tablist")
    await shellTabList.locator("button").last().click()
    await page.getByRole("menuitem", { name: "Review" }).click()

    const reviewTab = shellTabList.getByRole("tab", { name: "Review", exact: true })
    await expect(reviewTab).toHaveAttribute("aria-selected", "true")

    // The old vertical file-tree pane is gone by design.
    await expect(page.locator("#file-tree-panel")).toHaveCount(0)

    // The Review tab content area still renders (empty state is fine when no diffs).
    // The right panel has nested Tabs, so locate the panel via the tab's aria-controls
    // rather than .first() ordering.
    const reviewPanelId = await reviewTab.getAttribute("aria-controls")
    expect(reviewPanelId).toBeTruthy()
    await expect(page.locator(`#${reviewPanelId}`)).toBeVisible()
  })
})
