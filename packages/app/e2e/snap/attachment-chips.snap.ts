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
  // The dev-only performance debug bar and app-shell toasts (e.g. server
  // health checks) float over the page and bleed into block screenshots; they
  // are environment chrome, not the surface under test.
  await page.addStyleTag({
    content:
      'aside[aria-label="Development performance diagnostics"], [data-component="toast-region"] { display: none; }',
  })
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

  // The thumbnail opens the lightbox through real button semantics so
  // keyboard users can reach it: focus + Enter, not just mouse click.
  const thumbnailButton = pathBacked.getByRole("button", { name: "screenshot 2026-06-10.png" })
  await expect(thumbnailButton).toBeVisible()
  await thumbnailButton.focus()
  await page.keyboard.press("Enter")
  await expect(page.locator("body")).toHaveAttribute("data-opened-image", "screenshot 2026-06-10.png")

  const legacy = page.locator('[data-snap="legacy"]')
  await expect(legacy.locator('img[alt="pasted-image.png"]')).toBeVisible({ timeout: 30_000 })
  await expect(legacy).toContainText("notes.txt")
  // A pathless legacy part has no reveal action, so its card must not be a
  // focusable button that does nothing — remove is the only control.
  await expect(legacy.getByRole("button", { name: /notes\.txt/ })).toHaveCount(0)
  await expect(legacy.getByRole("button", { name: "Remove attachment" })).toHaveCount(2)

  // A path-backed image whose preview cannot load falls back to the file card.
  const fallback = page.locator('[data-snap="preview-fallback"]')
  await expect(fallback).toContainText("missing.png")
  await expect(fallback.locator("img")).toHaveCount(0)

  // Media chips the active model cannot see carry a warning badge with an
  // accessible reason; text-like chips and capability-covered media stay clean.
  const capability = page.locator('[data-snap="capability"]')
  const badges = capability.locator('[data-slot="attachment-warning"]')
  await expect(badges).toHaveCount(2)
  await expect(capability.getByRole("img", { name: "This model can't view images" })).toBeVisible()
  await expect(capability.getByRole("img", { name: "This model can't read PDFs" })).toBeVisible()
  // Blocks without a wired model never warn.
  await expect(pathBacked.locator('[data-slot="attachment-warning"]')).toHaveCount(0)
  // Hovering the chip surfaces the reason in its tooltip.
  await capability.locator('img[alt="screenshot 2026-06-10.png"]').hover()
  await expect(page.getByRole("tooltip")).toContainText("This model can't view images")
  await page.mouse.move(0, 0)
  // The badge tracks model switches in both directions.
  const toggle = page.getByRole("button", { name: "toggle vision" })
  await toggle.click()
  await expect(badges).toHaveCount(0)
  await toggle.click()
  await expect(badges).toHaveCount(2)

  const out = snapOutputPath("attachment-chips")
  await composeGrid(
    [
      await captureBlock("path-backed", pathBacked),
      await captureBlock("legacy", legacy),
      await captureBlock("preview-fallback", fallback),
      await captureBlock("capability", capability),
    ],
    out,
    { cols: 1 },
  )
  process.stdout.write(`\n[snap] attachment-chips grid -> ${out}\n\n`)
})
