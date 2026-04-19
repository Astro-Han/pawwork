import { test, expect } from "../fixtures"
import { withSession } from "../actions"
import { titlebarRightSelector } from "../selectors"

test("@smoke review keeps the persistent file-tree pane for review navigation", async ({ page, project }) => {
  await project.open()

  await withSession(project.sdk, `e2e file tree smoke ${Date.now()}`, async (session) => {
    await project.gotoSession(session.id)

    const rightToggle = page.locator(`${titlebarRightSelector} button`).first()
    const rightPanel = page.locator("#right-panel")
    const panel = page.locator("#file-tree-panel")
    const shellTabList = rightPanel.getByRole("tablist").first()

    await expect(rightToggle).toBeVisible()
    await rightToggle.click()
    await expect(rightPanel).toHaveAttribute("aria-hidden", "false")
    await expect(rightPanel).toBeVisible()
    const reviewTab = shellTabList.getByRole("tab", { name: "Review", exact: true })
    await reviewTab.click()
    await expect(reviewTab).toHaveAttribute("aria-selected", "true")
    await expect(panel).toBeVisible()
    await expect(panel.getByRole("tab", { name: /all/i })).toBeVisible()

    const openFile = rightPanel.getByRole("button", { name: /^Open file$/i }).first()
    await expect(openFile).toBeVisible()
    await openFile.click()

    const dialog = page
      .getByRole("dialog")
      .filter({ has: page.getByPlaceholder(/search files/i) })
      .first()
    await expect(dialog).toBeVisible()

    const input = dialog.getByRole("textbox").first()
    await input.fill("README.md")

    const file = dialog.locator('[data-slot="list-item"][data-key^="file:"]').first()
    await expect(file).toBeVisible({ timeout: 30_000 })
    await file.click()

    const tab = page.getByRole("tab", { name: "README.md" })
    await expect(tab).toBeVisible()
    await tab.click()
    await expect(tab).toHaveAttribute("aria-selected", "true")
    await expect(panel).toBeVisible()

    await rightToggle.click()
    await expect(rightPanel).toHaveAttribute("aria-hidden", "true")

    await rightToggle.click()
    await expect(reviewTab).toHaveAttribute("aria-selected", "true")

    const viewer = page.locator('[data-component="file"][data-mode="text"]').first()
    await expect(viewer).toBeVisible()
    await expect(viewer).toContainText("# e2e")
  })
})
