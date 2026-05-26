import { expect, type Locator } from "@playwright/test"
import { fileURLToPath } from "node:url"
import { test } from "../fixtures"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 720, height: 360 }, deviceScaleFactor: 2 })

const fixturePath = fileURLToPath(new URL("./fixtures/safe-retry-snap-fixture.tsx", import.meta.url))

async function captureBlock(name: string, block: Locator): Promise<Shot> {
  await expect(block).toBeVisible({ timeout: 30_000 })
  return { name, buf: await block.screenshot() }
}

async function waitForThemeBoot(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForFunction(
    () => getComputedStyle(document.documentElement).getPropertyValue("--bg-base").trim().length > 0,
    null,
    { timeout: 30_000 },
  )
}

test("safe-retry", async ({ page }) => {
  test.setTimeout(180_000)

  await page.goto("/")
  await waitForThemeBoot(page)
  await page.evaluate(async (path) => {
    const mod = await import(path)
    mod.mountSafeRetrySnapFixture(document.body)
  }, `/@fs/${fixturePath}`)

  const running = page.locator('[data-snap="running"]')
  await expect(running).toContainText("模型暂时没有响应，正在重试…", { timeout: 30_000 })
  await expect(running.locator('[data-slot="session-turn-safe-retry"]')).toBeVisible({ timeout: 30_000 })
  await expect(running.locator(".error-card")).toHaveCount(0)

  const notice = page.locator('[data-snap="notice"]')
  await expect(notice).toContainText("模型暂时没有响应。你可以稍后再试，或换一个模型。", { timeout: 30_000 })
  await expect(notice.locator('[data-kind="safe_retry_failed"]')).toBeVisible({ timeout: 30_000 })

  const out = snapOutputPath("safe-retry")
  await composeGrid([await captureBlock("running", running), await captureBlock("notice", notice)], out)
  process.stdout.write(`\n[snap] safe-retry grid -> ${out}\n\n`)
})
