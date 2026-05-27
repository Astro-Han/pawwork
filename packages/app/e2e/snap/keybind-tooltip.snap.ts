import { expect } from "@playwright/test"
import { test } from "../fixtures"
import { applyDarkModeForTests } from "../utils"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 480, height: 200 }, deviceScaleFactor: 2 })

// The keybind tooltip (titlebar / sidebar / composer shortcuts) only appears on
// hover over a real button, and the shortcut suffix is the same DOM everywhere:
// <span data-slot="tooltip-keybind-key">. Like worktree-tooltip, we inject that
// DOM after the global CSS loads instead of standing up the app shell — the
// shortcut's font/color come entirely from tooltip.css tokens, no Solid state.
//
// Guards two things: (1) the suffix renders in the sans stack, never monospace —
// the mono cell width is what crammed ⇧⌘ into one squished blob; (2) the visual
// grid lets a human confirm the glyphs read as separate keys, light and dark.

const TOOLTIP_HTML = `
  <div style="display:flex;align-items:center;justify-content:center;min-height:160px;background:var(--bg-base);">
    <div data-component="tooltip" data-expanded style="position:static;opacity:1;animation:none;">
      <div data-slot="tooltip-keybind">
        <span>新建会话</span>
        <span data-slot="tooltip-keybind-key">⇧⌘S</span>
      </div>
    </div>
  </div>
`

async function mountTooltip(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate((html) => {
    document.body.innerHTML = html
  }, TOOLTIP_HTML)
  await page.locator('[data-component="tooltip"][data-expanded]').waitFor({ state: "visible", timeout: 10_000 })
}

async function waitForThemeBoot(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForFunction(
    () => getComputedStyle(document.documentElement).getPropertyValue("--bg-base").trim().length > 0,
    null,
    { timeout: 30_000 },
  )
}

test("keybind-tooltip", async ({ page }) => {
  test.setTimeout(120_000)

  await page.goto("/")
  await waitForThemeBoot(page)
  await mountTooltip(page)

  // Regression lock: the shortcut suffix must use the sans stack, never mono.
  const fontFamily = await page
    .locator('[data-slot="tooltip-keybind-key"]')
    .evaluate((el) => getComputedStyle(el).fontFamily)
  expect(fontFamily).toContain("system-ui")
  expect(fontFamily.toLowerCase()).not.toContain("mono")

  const lightShot: Shot = {
    name: "light",
    buf: await page.locator('[data-component="tooltip"]').screenshot(),
  }

  await applyDarkModeForTests(page)
  await waitForThemeBoot(page)
  await mountTooltip(page)
  const darkShot: Shot = {
    name: "dark",
    buf: await page.locator('[data-component="tooltip"]').screenshot(),
  }

  const out = snapOutputPath("keybind-tooltip")
  await composeGrid([lightShot, darkShot], out)
  process.stdout.write(`\n[snap] keybind-tooltip grid -> ${out}\n\n`)
})
