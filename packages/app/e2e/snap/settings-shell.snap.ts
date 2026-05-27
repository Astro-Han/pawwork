import { test } from "../fixtures"
import { openSettings } from "../actions"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

// 验收 PR1 地基：两层 takeover 外壳 + 240 左 nav（返回应用 + 5 项 + 版本 foot）。
// nav 当前 5 项：通用/快捷键/模型/工作树/记忆（远程访问、集成页就绪前不露出）。
// 截 3 张：通用（默认）/ 模型（合并提供商+模型）/ 记忆（演示切到另一类页正常）。
test("settings-shell", async ({ page, project }) => {
  test.setTimeout(180_000)

  await project.open()

  const settings = await openSettings(page)
  await settings.waitFor({ state: "visible", timeout: 30_000 })

  const shots: Shot[] = [{ name: "general", buf: await settings.screenshot() }]

  for (const tab of ["Models", "Memory"] as const) {
    await settings.getByRole("tab", { name: tab }).click()
    await page.waitForTimeout(300)
    shots.push({ name: tab.toLowerCase(), buf: await settings.screenshot() })
  }

  const out = snapOutputPath("settings-shell")
  await composeGrid(shots, out)
  process.stdout.write(`\n[snap] settings-shell grid -> ${out}\n\n`)
})
