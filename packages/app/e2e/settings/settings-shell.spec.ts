import { test, expect } from "../fixtures"
import { closeSettingsPanel, openSettings } from "../actions"

// PR1 地基行为锁：两层 takeover 壳 + 扁平 nav，平移挂载 6 个现有页（远程/集成就绪前隐藏）。
test("settings shell shows the migrated nav and switches pages", async ({ page, gotoSession }) => {
  await gotoSession()

  const settings = await openSettings(page)

  // nav 当前 5 项：通用 / 快捷键 / 模型 / 工作树 / 记忆
  for (const name of ["General", "Shortcuts", "Models", "Worktrees", "Memory"]) {
    await expect(settings.getByRole("tab", { name })).toBeVisible()
  }
  // 远程访问 / 集成页就绪前不露出
  await expect(settings.getByRole("tab", { name: "Remote access" })).toHaveCount(0)
  await expect(settings.getByRole("tab", { name: "Integrations" })).toHaveCount(0)

  // 模型页 = 提供商 + 模型 堆叠复用：两块内容都在
  await settings.getByRole("tab", { name: "Models" }).click()
  await expect(settings.locator('[data-component="custom-provider-section"]')).toBeVisible()
  await expect(settings.getByPlaceholder("Search models")).toBeVisible()

  // 切到记忆页：模型页内容消失，证明内容随 nav 切换
  await settings.getByRole("tab", { name: "Memory" }).click()
  await expect(settings.locator('[data-component="custom-provider-section"]')).toHaveCount(0)

  await closeSettingsPanel(page, settings)
})

test("escape closes the settings shell", async ({ page, gotoSession }) => {
  await gotoSession()

  const settings = await openSettings(page)
  await expect(settings).toBeVisible()

  await page.keyboard.press("Escape")
  await expect(page.locator('[data-component="settings-page"]')).toHaveCount(0)
})

test("back-to-app button closes the settings shell", async ({ page, gotoSession }) => {
  await gotoSession()

  const settings = await openSettings(page)
  await expect(settings).toBeVisible()

  await settings.getByRole("button", { name: "Back to app" }).click()
  await expect(page.locator('[data-component="settings-page"]')).toHaveCount(0)
})
