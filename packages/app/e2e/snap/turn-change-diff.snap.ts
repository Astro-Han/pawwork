import { test, expect } from "../fixtures"
import { routeTurnChangeDiff, TURN_CHANGE_MODIFIED_DIFF_FILE_PATH } from "../session/turn-change-diff-fixture"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

test("turn-change-diff", async ({ page, llm, project }) => {
  test.setTimeout(180_000)

  await project.open()
  await routeTurnChangeDiff(page, { sessionID: "snap-session" })

  await llm.text("seeded turn-change diff")
  await project.prompt("snap turn-change diff")

  const card = page.locator('[data-slot="session-turn-changes"]').last()
  await expect(card).toBeVisible({ timeout: 30_000 })
  const row = card
    .locator('[data-slot="session-turn-change-row"]')
    .filter({ hasText: TURN_CHANGE_MODIFIED_DIFF_FILE_PATH })
    .first()
  await expect(row).toBeVisible()

  const shots: Shot[] = [{ name: "collapsed", buf: await card.screenshot() }]

  await row.click()
  const diff = card.locator('[data-slot="session-turn-change-diff"]').first()
  await expect(diff).toBeVisible()
  await expect
    .poll(async () => await diff.evaluate((el) => Number.parseFloat(getComputedStyle(el).minHeight)), {
      timeout: 10_000,
    })
    .toBeGreaterThanOrEqual(384)
  await expect(diff.locator("[data-line]").first()).toBeVisible({ timeout: 30_000 })

  shots.push({ name: "expanded-card", buf: await card.screenshot() })

  const out = snapOutputPath("turn-change-diff")
  await composeGrid(shots, out)
  process.stdout.write(`\n[snap] turn-change-diff grid -> ${out}\n\n`)
})
