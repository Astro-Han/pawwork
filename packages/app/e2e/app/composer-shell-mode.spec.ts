import { expect, test } from "../fixtures"
import { promptSelector } from "../selectors"

test("shell mode surfaces via textarea placeholder and no docktray label remains", async ({ page, project }) => {
  await project.open()
  const prompt = page.locator(promptSelector)
  await prompt.click()
  await page.keyboard.type("!")

  const placeholder = page.locator('[data-component="prompt-placeholder"]')
  // zh "输入 shell 命令..." / en "Enter shell command...", both contain "shell"
  await expect(placeholder).toContainText(/shell/i)

  // no standalone DockTray remains after unification
  await expect(page.locator('[data-dock-surface="tray"]')).toHaveCount(0)

  // leaving shell mode: placeholder returns to default (no "shell" substring)
  await page.keyboard.press("Escape")
  await expect(placeholder).not.toContainText(/shell/i)
})
