import { expect, type Locator, type Page } from "@playwright/test"
import { fileURLToPath } from "node:url"
import { test } from "../fixtures"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 920, height: 200 }, deviceScaleFactor: 2 })

const fixturePath = fileURLToPath(new URL("./fixtures/turn-status-phase-snap-fixture.tsx", import.meta.url))

async function waitForThemeBoot(page: Page): Promise<void> {
  await page.waitForFunction(
    () => getComputedStyle(document.documentElement).getPropertyValue("--bg-base").trim().length > 0,
    null,
    { timeout: 30_000 },
  )
}

async function capture(name: string, block: Locator): Promise<Shot> {
  await expect(block).toBeVisible({ timeout: 30_000 })
  return { name, buf: await block.screenshot() }
}

test("turn-status-phase", async ({ page }) => {
  test.setTimeout(180_000)

  await page.goto("/")
  await waitForThemeBoot(page)
  await page.evaluate(async (path) => {
    const mod = await import(path)
    // Wipe the booted app shell so its dev chrome can't bleed into the capture.
    document.body.replaceChildren()
    const root = document.createElement("div")
    document.body.appendChild(root)
    mod.mountTurnStatusPhaseSnapFixture(root)
  }, `/@fs/${fixturePath}`)

  const connecting = page.locator('[data-snap="connecting"]')
  const thinking = page.locator('[data-snap="thinking"]')
  const recovery = page.locator('[data-snap="recovery"]')

  // Before first provider progress: connecting, not thinking.
  await expect(connecting.locator('[data-phase="connecting"]')).toBeVisible({ timeout: 30_000 })
  await expect(connecting).toContainText("连接中")
  // After provider progress: thinking.
  await expect(thinking.locator('[data-phase="thinking"]')).toBeVisible()
  await expect(thinking).toContainText("思考中")
  // Safe recovery names the attempt.
  await expect(recovery.locator('[data-slot="session-turn-safe-retry"]')).toBeVisible()
  await expect(recovery).toContainText("正在恢复…第 2 次")

  const out = snapOutputPath("turn-status-phase")
  await composeGrid(
    [
      await capture("before first provider progress", connecting),
      await capture("provider responding", thinking),
      await capture("safe recovery, attempt 2", recovery),
    ],
    out,
  )
  process.stdout.write(`\n[snap] turn-status-phase grid -> ${out}\n\n`)
})
