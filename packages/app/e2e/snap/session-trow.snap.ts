import { expect, type Locator } from "@playwright/test"
import { test } from "../fixtures"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 900, height: 560 }, deviceScaleFactor: 2 })

const LANGUAGE_KEY = "pawwork.global.dat:language"
const TROW_BLOCK = '[data-component="session-turn-trow-block"]'
async function captureTrow(name: string, trow: Locator): Promise<Shot> {
  await expect(trow).toBeVisible({ timeout: 30_000 })
  return { name, buf: await trow.screenshot() }
}

test("session-trow", async ({ page, project, llm }) => {
  test.setTimeout(180_000)

  await page.addInitScript((key) => {
    localStorage.setItem(key, JSON.stringify({ locale: "zh" }))
  }, LANGUAGE_KEY)

  await project.open()

  const shots: Shot[] = []

  await llm.tool("read", { filePath: "README.md" })
  await llm.tool("glob", { pattern: "**/*.md" })
  await llm.tool("bash", { command: "echo one", description: "first command" })
  await llm.text("混合工具已完成。")

  await project.prompt("snap session trow mixed")

  const trow = page.locator(TROW_BLOCK).first()
  await expect(trow).toBeVisible({ timeout: 60_000 })
  await expect(page.locator(TROW_BLOCK)).toHaveCount(1, { timeout: 60_000 })

  shots.push(await captureTrow("mixed-collapsed", trow))

  await trow.locator("summary").click()
  await expect(trow.locator('[data-slot="trow-body"]')).toBeVisible({ timeout: 10_000 })
  await expect(trow.locator('[data-slot="trow-item"]')).toHaveCount(3, { timeout: 10_000 })
  shots.push(await captureTrow("mixed-expanded", trow))

  await trow.locator('[data-slot="trow-item"]').nth(2).locator('[data-slot="collapsible-trigger"]').click()
  await expect(trow.locator('[data-component="bash-output"]')).toBeVisible({ timeout: 10_000 })
  shots.push(await captureTrow("inner-bash-expanded", trow))

  await llm.tool("bash", { command: "sleep 0", description: "quiet command" })
  await llm.text("安静命令完成。")
  await project.prompt("snap session trow quiet")

  const quiet = page.locator(TROW_BLOCK).last()
  await expect(quiet.locator('[data-slot="trow-summary-text"]')).toContainText("已运行 1 条命令", { timeout: 60_000 })
  shots.push(await captureTrow("single-command", quiet))

  const out = snapOutputPath("session-trow")
  await composeGrid(shots, out, { cols: 2 })
  process.stdout.write(`\n[snap] session-trow grid -> ${out}\n\n`)
})
