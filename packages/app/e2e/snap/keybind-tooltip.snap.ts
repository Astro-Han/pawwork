import { expect } from "@playwright/test"
import { test } from "../fixtures"
import { applyDarkModeForTests } from "../utils"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 520, height: 240 }, deviceScaleFactor: 2 })

// The keybind tooltip (titlebar / sidebar / composer shortcuts) only appears on
// hover over a real button, and the shortcut suffix is the same DOM everywhere:
// <span data-slot="tooltip-keybind-key">. Like worktree-tooltip, we inject that
// DOM after the global CSS loads instead of standing up the app shell — the
// shortcut's font/color come entirely from tooltip.css tokens, no Solid state.
//
// Renders both UI languages (zh + en) stacked, because the chrome ships
// bilingual: the label font switches by lang while the shortcut glyphs stay the
// same Latin sans. Guards two things: (1) every suffix renders in the sans
// stack, never monospace — the mono cell width is what crammed ⇧⌘ into one
// squished blob; (2) the visual grid lets a human confirm the glyphs read as
// separate keys across language and light/dark.

const STAGE_HTML = `
  <div
    data-snap-stage
    style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;min-height:200px;padding:20px;background:var(--bg-base);"
  >
    <div data-component="tooltip" data-expanded lang="zh" style="position:static;opacity:1;animation:none;">
      <div data-slot="tooltip-keybind">
        <span>新建会话</span>
        <span data-slot="tooltip-keybind-key">⇧⌘S</span>
      </div>
    </div>
    <div data-component="tooltip" data-expanded lang="en" style="position:static;opacity:1;animation:none;">
      <div data-slot="tooltip-keybind">
        <span>New session</span>
        <span data-slot="tooltip-keybind-key">⇧⌘S</span>
      </div>
    </div>
  </div>
`

async function mountStage(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate((html) => {
    document.body.innerHTML = html
  }, STAGE_HTML)
  await page.locator("[data-snap-stage]").waitFor({ state: "visible", timeout: 10_000 })
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
  await mountStage(page)

  // Regression lock: every shortcut suffix (zh + en) must use the sans stack,
  // never mono.
  const fontFamilies = await page
    .locator('[data-slot="tooltip-keybind-key"]')
    .evaluateAll((els) => els.map((el) => getComputedStyle(el).fontFamily))
  expect(fontFamilies.length).toBe(2)
  for (const family of fontFamilies) {
    expect(family).toContain("system-ui")
    expect(family.toLowerCase()).not.toContain("mono")
  }

  const lightShot: Shot = {
    name: "light",
    buf: await page.locator("[data-snap-stage]").screenshot(),
  }

  await applyDarkModeForTests(page)
  await waitForThemeBoot(page)
  await mountStage(page)
  const darkShot: Shot = {
    name: "dark",
    buf: await page.locator("[data-snap-stage]").screenshot(),
  }

  const out = snapOutputPath("keybind-tooltip")
  await composeGrid([lightShot, darkShot], out)
  process.stdout.write(`\n[snap] keybind-tooltip grid -> ${out}\n\n`)
})
