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
  await expect(running).toContainText("正在恢复…", { timeout: 30_000 })
  await expect(running.locator('[data-slot="session-turn-safe-retry"]')).toBeVisible({ timeout: 30_000 })
  await expect(running.locator(".error-card")).toHaveCount(0)

  const notice = page.locator('[data-snap="notice"]')
  await expect(notice).toContainText("恢复失败。你可以稍后再试，或换一个模型。", { timeout: 30_000 })
  // The notice follows a reasoning trow; assert both render so the captured
  // grid covers the #943 boundary scenario (notice must not attach to thinking).
  await expect(notice.locator('[data-component="session-turn-trow-block"]')).toBeVisible({ timeout: 30_000 })
  await expect(notice.locator('[data-kind="safe_retry_failed"]')).toBeVisible({ timeout: 30_000 })

  // The grid is a visual aid, not a pixel diff, so assert the divider directly:
  // a notice that follows turn content carries the hairline + padding (#943).
  const precededStyle = await notice.locator('[data-component="notice-part"]').evaluate((el) => {
    const s = getComputedStyle(el)
    return { borderTop: s.borderTopWidth, paddingTop: s.paddingTop }
  })
  expect(precededStyle.borderTop).toBe("1px")
  expect(precededStyle.paddingTop).toBe("12px")

  // A notice that is the turn's only part must carry no leading divider.
  const standalone = page.locator('[data-snap="notice-standalone"]')
  await expect(standalone.locator('[data-kind="safe_retry_failed"]')).toBeVisible({ timeout: 30_000 })
  const standaloneStyle = await standalone.locator('[data-component="notice-part"]').evaluate((el) => {
    const s = getComputedStyle(el)
    return { borderTop: s.borderTopWidth, paddingTop: s.paddingTop }
  })
  expect(standaloneStyle.borderTop).toBe("0px")
  expect(standaloneStyle.paddingTop).toBe("0px")

  const out = snapOutputPath("safe-retry")
  await composeGrid(
    [
      await captureBlock("running", running),
      await captureBlock("notice", notice),
      await captureBlock("notice-standalone", standalone),
    ],
    out,
  )
  process.stdout.write(`\n[snap] safe-retry grid -> ${out}\n\n`)
})
