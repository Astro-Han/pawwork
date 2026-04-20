import { test, expect } from "../fixtures"
import { withSession } from "../actions"
import { titlebarRightSelector } from "../selectors"

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

    const rightToggle = page.locator(`${titlebarRightSelector} button`).first()
    const rightPanel = page.locator("#right-panel")
    const shellTabList = rightPanel.getByRole("tablist").first()

    await expect(rightToggle).toBeVisible()
    await rightToggle.click()
    await expect(rightPanel).toHaveAttribute("aria-hidden", "false")

    const reviewTab = shellTabList.getByRole("tab", { name: "Review", exact: true })
    await reviewTab.click()
    await expect(reviewTab).toHaveAttribute("aria-selected", "true")

    // The old vertical file-tree pane is gone by design.
    await expect(page.locator("#file-tree-panel")).toHaveCount(0)

    // The Review tab content area still renders (empty state is fine when no diffs).
    const reviewContent = rightPanel.getByRole("tabpanel").first()
    await expect(reviewContent).toBeVisible()
  })
})
