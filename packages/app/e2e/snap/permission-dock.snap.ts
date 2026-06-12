import { expect, type Locator } from "@playwright/test"
import { fileURLToPath } from "node:url"
import { test } from "../fixtures"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 760, height: 420 }, deviceScaleFactor: 2 })

const fixturePath = fileURLToPath(new URL("./fixtures/permission-dock-fixture.tsx", import.meta.url))

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

test("permission-dock", async ({ page }) => {
  test.setTimeout(180_000)

  await page.goto("/")
  await waitForThemeBoot(page)
  await page.addStyleTag({
    content:
      'aside[aria-label="Development performance diagnostics"], [data-component="toast-region"] { display: none; }',
  })
  await page.evaluate(async (path) => {
    const mod = await import(path)
    mod.mountPermissionDockFixture(document.body)
  }, `/@fs/${fixturePath}`)

  const deleteOnce = page.locator('[data-snap="delete-once"]')
  await expect(deleteOnce).toContainText('Delete automation "Daily repo brief" (aut_daily)', { timeout: 30_000 })
  await expect(deleteOnce.getByRole("button", { name: "Allow once" })).toBeVisible()
  await expect(deleteOnce.getByRole("button", { name: "Deny" })).toBeVisible()
  await expect(deleteOnce.getByRole("button", { name: "Allow always" })).toHaveCount(0)

  const persistable = page.locator('[data-snap="persistable"]')
  await expect(persistable).toContainText("echo ok", { timeout: 30_000 })
  await expect(persistable.getByRole("button", { name: "Allow always" })).toBeVisible()

  const out = snapOutputPath("permission-dock")
  await composeGrid(
    [
      await captureBlock("delete-once", deleteOnce),
      await captureBlock("persistable", persistable),
    ],
    out,
    { cols: 1 },
  )
  process.stdout.write(`\n[snap] permission-dock grid -> ${out}\n\n`)
})
