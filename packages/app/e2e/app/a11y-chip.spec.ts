import { test, expect } from "../fixtures"

test("WorkspaceChip renders in home, absent in session", async ({ page, project }) => {
  await project.open()
  const chip = page.getByRole("button", { name: /Switch workspace|切换工作目录/i })
  await expect(chip).toBeVisible()

  await project.prompt("Start a session from home")
  await expect.poll(() => page.url(), { timeout: 30_000 }).toContain("/session/")
  await expect(chip).toHaveCount(0)
})

test("WorkspaceChip selection navigates to the chosen workspace", async ({ page, project }) => {
  await project.open()
  const chip = page.getByRole("button", { name: /Switch workspace|切换工作目录/i })

  await chip.click()
  const listbox = page.getByRole("listbox", { name: /Workspaces|工作目录/i })
  await expect(listbox).toBeVisible()
  const options = listbox.getByRole("option")
  const optionCount = await options.count()
  test.skip(optionCount < 2, "need at least 2 workspaces seeded to exercise a switch")

  const target = options.nth(1)
  const targetLabel = await target.textContent()
  const urlBefore = page.url()

  await target.click()
  await expect(listbox).toHaveCount(0)
  await expect.poll(() => page.url()).not.toBe(urlBefore)
  await expect(chip).toContainText(targetLabel?.trim() ?? "")
})

test("WorkspaceChip popover ESC + outside-click dismiss", async ({ page, project }) => {
  await project.open()
  const chip = page.getByRole("button", { name: /Switch workspace|切换工作目录/i })

  await chip.focus()
  await page.keyboard.press("Enter")
  const listbox = page.getByRole("listbox", { name: /Workspaces|工作目录/i })
  await expect(listbox).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(listbox).toHaveCount(0)
  await expect(chip).toBeFocused()

  await chip.click()
  await expect(listbox).toBeVisible()
  await page.locator('[data-component="session-new-home"]').click({ position: { x: 5, y: 5 } })
  await expect(listbox).toHaveCount(0)
})
