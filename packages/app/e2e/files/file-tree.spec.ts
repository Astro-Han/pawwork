import { test, expect } from "../fixtures"
import { withSession } from "../actions"

test("@smoke file tree entrypoints can open the panel and a file", async ({ page, project }) => {
  await project.open()

  await withSession(project.sdk, `e2e file tree smoke ${Date.now()}`, async (session) => {
    await project.gotoSession(session.id)

    const fileToggle = page.getByRole("button", { name: "Toggle file tree" })
    const reviewToggle = page.getByRole("button", { name: "Toggle review" })
    const reviewPanel = page.locator("#review-panel")
    const panel = page.locator("#file-tree-panel")
    const treeTabs = panel.locator('[data-component="tabs"][data-variant="pill"][data-scope="filetree"]')

    await expect(fileToggle).toBeVisible()
    if ((await fileToggle.getAttribute("aria-expanded")) !== "true") await fileToggle.click()
    await expect(fileToggle).toHaveAttribute("aria-expanded", "true")
    await expect(reviewPanel).toHaveAttribute("aria-hidden", "false")
    await expect(reviewPanel).toBeVisible()
    await expect(reviewPanel).toContainText("No files")

    await expect(reviewToggle).toBeVisible()
    await reviewToggle.click()
    await expect(reviewToggle).toHaveAttribute("aria-expanded", "true")
    await expect(fileToggle).toHaveAttribute("aria-expanded", "false")
    await expect(panel).toBeVisible()
    await expect(treeTabs).toBeVisible()

    const allTab = treeTabs.getByRole("tab", { name: /^all files$/i })
    await expect(allTab).toBeVisible()
    await allTab.click()
    await expect(allTab).toHaveAttribute("aria-selected", "true")

    const tree = treeTabs.locator('[data-slot="tabs-content"]:not([hidden])')
    await expect(tree).toBeVisible()

    const file = tree.getByRole("button", { name: "README.md", exact: true }).first()
    await expect(file).toBeVisible()
    await file.click()

    const tab = page.getByRole("tab", { name: "README.md" })
    await expect(tab).toBeVisible()
    await tab.click()
    await expect(tab).toHaveAttribute("aria-selected", "true")

    await reviewToggle.click()
    await expect(reviewToggle).toHaveAttribute("aria-expanded", "false")

    await reviewToggle.click()
    await expect(reviewToggle).toHaveAttribute("aria-expanded", "true")
    await expect(allTab).toHaveAttribute("aria-selected", "true")

    const viewer = page.locator('[data-component="file"][data-mode="text"]').first()
    await expect(viewer).toBeVisible()
    await expect(viewer).toContainText("# e2e")
  })
})
