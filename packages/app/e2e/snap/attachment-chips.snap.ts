import { expect, type Locator } from "@playwright/test"
import { fileURLToPath } from "node:url"
import { test } from "../fixtures"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 720, height: 600 }, deviceScaleFactor: 2 })

const fixturePath = fileURLToPath(new URL("./fixtures/attachment-chips-fixture.tsx", import.meta.url))

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

test("attachment-chips", async ({ page }) => {
  test.setTimeout(180_000)

  await page.goto("/")
  await waitForThemeBoot(page)
  // The dev-only performance debug bar floats bottom-right and bleeds into
  // block screenshots; it is environment chrome, not the surface under test.
  await page.addStyleTag({ content: 'aside[aria-label="Development performance diagnostics"] { display: none; }' })
  await page.evaluate(async (path) => {
    const mod = await import(path)
    mod.mountAttachmentChipsFixture(document.body)
  }, `/@fs/${fixturePath}`)

  const pathBacked = page.locator('[data-snap="path-backed"]')
  // Path-backed image resolves its thumbnail through loadPreview.
  await expect(pathBacked.locator('img[alt="screenshot 2026-06-10.png"]')).toBeVisible({ timeout: 30_000 })
  await expect(pathBacked).toContainText("quarterly-report.pdf")
  await expect(pathBacked).toContainText("1.1 MB")
  // Every chip carries a persistent remove control.
  await expect(pathBacked.getByRole("button", { name: "Remove attachment" })).toHaveCount(3)

  const legacy = page.locator('[data-snap="legacy"]')
  await expect(legacy.locator('img[alt="pasted-image.png"]')).toBeVisible({ timeout: 30_000 })
  await expect(legacy).toContainText("notes.txt")

  // A path-backed image whose preview cannot load falls back to the file card.
  const fallback = page.locator('[data-snap="preview-fallback"]')
  await expect(fallback).toContainText("missing.png")
  await expect(fallback.locator("img")).toHaveCount(0)

  const out = snapOutputPath("attachment-chips")
  await composeGrid(
    [
      await captureBlock("path-backed", pathBacked),
      await captureBlock("legacy", legacy),
      await captureBlock("preview-fallback", fallback),
    ],
    out,
    { cols: 1 },
  )
  process.stdout.write(`\n[snap] attachment-chips grid -> ${out}\n\n`)
})
