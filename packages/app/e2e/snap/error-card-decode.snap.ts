import { expect, type Locator, type Page } from "@playwright/test"
import { fileURLToPath } from "node:url"
import { test } from "../fixtures"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 720, height: 900 }, deviceScaleFactor: 2 })

const fixturePath = fileURLToPath(new URL("./fixtures/error-card-decode-snap-fixture.tsx", import.meta.url))

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

test("error-card-decode", async ({ page }) => {
  test.setTimeout(180_000)

  await page.goto("/")
  await waitForThemeBoot(page)
  await page.evaluate(async (path) => {
    const mod = await import(path)
    // Wipe the booted app shell so its dev chrome can't bleed into the capture.
    document.body.replaceChildren()
    const root = document.createElement("div")
    document.body.appendChild(root)
    mod.mountErrorCardDecodeSnapFixture(root)
  }, `/@fs/${fixturePath}`)

  const grid = page.locator('[data-snap-grid="error-card-decode"]')
  await expect(grid).toBeVisible({ timeout: 30_000 })

  // The structured 402 body surfaces the provider's real reason, not the raw
  // "402 status code" message — the user-visible billing fix.
  const structured = page.locator('[data-snap="402 structured body"]')
  await expect(structured).toContainText("unknown_error: Insufficient Balance", { timeout: 30_000 })
  await expect(structured).not.toContainText("402 status code")

  // Embedded JSON resolves to the reason, never the JSON blob.
  await expect(page.locator('[data-snap="json-in-message"]')).toContainText("rate limited")
  await expect(page.locator('[data-snap="json-in-message"]')).not.toContainText("{")

  // The generic message still renders verbatim when the payload carries no
  // structured reason to surface (the decoder must not invent one).
  await expect(page.locator('[data-snap="plain fallback"]')).toContainText("Connection lost")

  const out = snapOutputPath("error-card-decode")
  await composeGrid([await capture("error cards", grid)], out)
  process.stdout.write(`\n[snap] error-card-decode grid -> ${out}\n\n`)
})
