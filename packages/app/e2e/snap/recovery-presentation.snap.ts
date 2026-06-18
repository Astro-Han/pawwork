import { expect, type Locator, type Page } from "@playwright/test"
import { fileURLToPath } from "node:url"
import { test } from "../fixtures"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 840, height: 420 }, deviceScaleFactor: 2 })

const fixturePath = fileURLToPath(new URL("./fixtures/recovery-presentation-snap-fixture.tsx", import.meta.url))

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

test("recovery-presentation", async ({ page }) => {
  test.setTimeout(180_000)

  await page.goto("/")
  await waitForThemeBoot(page)
  await page.evaluate(async (path) => {
    const mod = await import(path)
    // Wipe the booted app shell so its dev chrome can't bleed into the capture.
    document.body.replaceChildren()
    const root = document.createElement("div")
    document.body.appendChild(root)
    mod.mountRecoveryPresentationSnapFixture(root)
  }, `/@fs/${fixturePath}`)

  const sideEffect = page.locator('[data-snap="side-effect"]')
  const fallback = page.locator('[data-snap="default"]')

  // Side-effect turn: completed bash tool card above, reassuring side-effect copy.
  await expect(sideEffect).toContainText("在 #1358 下留言", { timeout: 30_000 })
  await expect(sideEffect.locator('[data-kind="safe_retry_failed"][data-variant="side-effect"]')).toBeVisible()
  await expect(sideEffect).toContainText("操作已完成")

  // No-tool turn: default copy, no tool card.
  await expect(fallback.locator('[data-kind="safe_retry_failed"][data-variant="default"]')).toBeVisible({
    timeout: 30_000,
  })
  await expect(fallback).toContainText("回复未完成")

  const out = snapOutputPath("recovery-presentation")
  await composeGrid(
    [await capture("after side-effecting tool", sideEffect), await capture("reply never started", fallback)],
    out,
  )
  process.stdout.write(`\n[snap] recovery-presentation grid -> ${out}\n\n`)
})
