import { expect } from "@playwright/test"
import { fileURLToPath } from "node:url"
import { test } from "../fixtures"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2 })

const fixturePath = fileURLToPath(new URL("./fixtures/session-opening-skeleton-fixture.tsx", import.meta.url))

async function waitForThemeBoot(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForFunction(
    () => getComputedStyle(document.documentElement).getPropertyValue("--bg-base").trim().length > 0,
    null,
    { timeout: 30_000 },
  )
}

async function capture(page: import("@playwright/test").Page, name: string): Promise<Shot> {
  const root = page.locator('[data-component="session-opening-state"]')
  await expect(root).toBeVisible({ timeout: 30_000 })
  await expect(root.locator(".animate-spin")).toHaveCount(0)
  await expect(root.locator("button")).toHaveCount(0)
  return { name, buf: await page.locator("body").screenshot() }
}

test("session-opening-skeleton", async ({ page }) => {
  test.setTimeout(180_000)

  await page.goto("/")
  await waitForThemeBoot(page)
  await page.evaluate(async (path) => {
    const mod = await import(path)
    mod.mountSessionOpeningSkeletonFixture(document.body)
  }, `/@fs/${fixturePath}`)

  const desktop = await capture(page, "desktop")

  await page.setViewportSize({ width: 768, height: 820 })
  const narrow = await capture(page, "narrow")

  const out = snapOutputPath("session-opening-skeleton")
  await composeGrid([desktop, narrow], out)
  process.stdout.write(`\n[snap] session-opening-skeleton grid -> ${out}\n\n`)
})
