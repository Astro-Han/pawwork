import { expect, type Locator, type Page } from "@playwright/test"
import { fileURLToPath } from "node:url"
import { test } from "../fixtures"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 1200, height: 760 }, deviceScaleFactor: 2 })

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

  const zh = page.locator('[data-lang="中文"]')
  const en = page.locator('[data-lang="English"]')

  // Side-effect, REAL cross-message topology: the bash card lives on message A,
  // the notice on message B; the backend `sideEffect` flag still drives the
  // reassuring copy that names "no redo".
  const zhSide = zh.locator('[data-snap="side-effect"]')
  await expect(zhSide).toContainText("在 #1358 下留言", { timeout: 30_000 })
  await expect(zhSide.locator('[data-kind="safe_retry_failed"][data-variant="side-effect"]')).toBeVisible()
  await expect(zhSide).toContainText("操作已完成")
  await expect(zhSide).toContainText("无需重复")

  // Read-only turn: a grep ran, but it carries no side effect, so the backend
  // sets sideEffect=false and the notice falls back to the default copy.
  const zhRead = zh.locator('[data-snap="read-only"]')
  await expect(zhRead.locator('[data-kind="safe_retry_failed"][data-variant="default"]')).toBeVisible()
  await expect(zhRead).toContainText("回复未完成")
  await expect(zhRead).not.toContainText("操作已完成")

  // No-tool turn: default copy.
  await expect(zh.locator('[data-snap="default"] [data-variant="default"]')).toBeVisible()

  // English mirrors the same three scenarios.
  const enSide = en.locator('[data-snap="side-effect"]')
  await expect(enSide.locator('[data-variant="side-effect"]')).toBeVisible({ timeout: 30_000 })
  await expect(enSide).toContainText("Action completed")
  await expect(en.locator('[data-snap="read-only"] [data-variant="default"]')).toBeVisible()
  await expect(en.locator('[data-snap="read-only"]')).toContainText("Reply incomplete")

  const out = snapOutputPath("recovery-presentation")
  await composeGrid([await capture("中文", zh), await capture("English", en)], out)
  process.stdout.write(`\n[snap] recovery-presentation grid -> ${out}\n\n`)
})
