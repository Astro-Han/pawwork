import { test, expect } from "../fixtures"
import { openRightPanel } from "../actions"
import { composeGrid, snapOutputPath } from "./_compose"

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

test("session-context-cache", async ({ page, llm, project }) => {
  await project.open()

  await llm.text("Seeded context cache usage.", { usage: { input: 1_000, output: 40, cacheRead: 900 } })
  await project.prompt("snap context cache hit rate")

  const panel = await openRightPanel(page)
  await page.getByRole("button", { name: "View context usage" }).click()
  await page.getByRole("tab", { name: "Context" }).click()

  await expect(panel.getByText("Cache Hit Rate")).toBeVisible()
  await expect(panel.getByText("90%")).toBeVisible()

  const toastCloseButtons = page.locator('[data-component="toast"] [data-slot="toast-close-button"]')
  const toastCount = await toastCloseButtons.count()
  for (let index = 0; index < toastCount; index++) {
    await toastCloseButtons.first().click()
  }
  await expect(page.locator('[data-component="toast"]')).toHaveCount(0)

  const shot = await panel.screenshot({ animations: "disabled" })
  const out = snapOutputPath("session-context-cache")
  await composeGrid([{ name: "right-panel context cache", buf: shot }], out)
  process.stdout.write(`\n[snap] session-context-cache grid -> ${out}\n\n`)
})
