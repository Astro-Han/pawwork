import { test, expect } from "../fixtures"
import { openRightPanel } from "../actions"
import { composeGrid, snapOutputPath } from "./_compose"

async function widenRightPanel(page: Parameters<typeof openRightPanel>[0]) {
  const handle = page.locator('[data-component="right-panel-resize-wrapper"] [data-component="resize-handle"]')
  const box = await handle.boundingBox()
  if (!box) throw new Error("right panel resize handle is not visible")

  const startX = box.x + box.width / 2
  const startY = box.y + box.height / 2
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX - 180, startY, { steps: 12 })
  await page.mouse.up()

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const panel = document.getElementById("right-panel")
          return panel?.getBoundingClientRect().width ?? 0
        }),
      { timeout: 2_000 },
    )
    .toBeGreaterThanOrEqual(512)
}

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

test("session-context-cache", async ({ page, llm, project }) => {
  await project.open()

  // Two turns so the session aggregate differs from the latest turn:
  //   turn 1: 40,000 cache read of 80,000 input
  //   turn 2: 108,000 cache read of 120,000 input -> 90.0% this turn
  //   session: 148,000 read of 200,000 total -> 74.0%
  await llm.text("First seeded turn.", { usage: { input: 80_000, output: 500, cacheRead: 40_000 } })
  await project.prompt("first turn")
  await llm.text("Second seeded turn.", { usage: { input: 120_000, output: 800, cacheRead: 108_000 } })
  await project.prompt("snap context cache hit rate")

  const panel = await openRightPanel(page)
  await page.getByRole("button", { name: "View context usage" }).click()
  await page.getByRole("tab", { name: "Context" }).click()

  await expect(panel.getByText("Context budget")).toBeVisible()
  // Cache shows both scopes at once: 90.0% this turn beside 74.0% session.
  await expect(panel.getByText("90.0%")).toBeVisible()
  await expect(panel.getByText("74.0%").first()).toBeVisible()

  const toastCloseButtons = page.locator('[data-component="toast"] [data-slot="toast-close-button"]')
  const toastCount = await toastCloseButtons.count()
  for (let index = 0; index < toastCount; index++) {
    await toastCloseButtons.first().click()
  }
  await expect(page.locator('[data-component="toast"]')).toHaveCount(0)

  const defaultShot = await panel.screenshot({ animations: "disabled" })
  await widenRightPanel(page)
  const wideShot = await panel.screenshot({ animations: "disabled" })

  const out = snapOutputPath("session-context-cache")
  await composeGrid(
    [
      { name: "default width", buf: defaultShot },
      { name: "wide two-column", buf: wideShot },
    ],
    out,
  )
  process.stdout.write(`\n[snap] session-context-cache grid -> ${out}\n\n`)
})
