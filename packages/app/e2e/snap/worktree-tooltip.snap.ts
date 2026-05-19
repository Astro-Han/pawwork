import { test } from "../fixtures"
import { applyDarkModeForTests } from "../utils"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 720, height: 360 }, deviceScaleFactor: 2 })

// The badge tooltip only renders inside a session that's already bound to a
// worktree. Standing up that backend state for a static color check costs more
// than the fix it guards. Instead we navigate to the app root so the global
// CSS (tooltip background/color + text utilities) loads, then inject the same
// DOM the badge produces and snap it. The check is faithful because tooltip
// surface color, text color, and the per-row classes are all global tokens —
// no Solid component state involved.

const TOOLTIP_HTML = `
  <div style="display:flex;align-items:center;justify-content:center;min-height:300px;background:var(--bg-base);">
    <div
      data-component="tooltip"
      data-expanded
      style="position:static;opacity:1;animation:none;max-width:420px;"
    >
      <div data-component="pawwork-worktree-tooltip" class="grid min-w-0 gap-1.5 py-1 text-left">
        <div class="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] items-start gap-3">
          <span class="text-caption">Worktree</span>
          <span class="text-h3 min-w-0 break-all leading-[1.45]">fix-tooltip-dark-mode</span>
        </div>
        <div class="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] items-start gap-3">
          <span class="text-caption">Branch</span>
          <span class="text-body min-w-0 break-all leading-[1.45]">claude/fix-tooltip-dark-mode</span>
        </div>
        <div class="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] items-start gap-3">
          <span class="text-caption">Location</span>
          <span class="text-body min-w-0 break-all leading-[1.45]">/Users/yuhan/workspace/dev/pawwork/.claude/worktrees/fix-tooltip-dark-mode</span>
        </div>
      </div>
    </div>
  </div>
`

async function mountTooltip(page: import("@playwright/test").Page): Promise<void> {
  // Replace the app shell while keeping the head (stylesheets, theme <style id="oc-theme">).
  await page.evaluate((html) => {
    document.body.innerHTML = html
  }, TOOLTIP_HTML)
  await page.locator('[data-component="tooltip"][data-expanded]').waitFor({ state: "visible", timeout: 10_000 })
}

async function waitForThemeBoot(page: import("@playwright/test").Page): Promise<void> {
  // Theme tokens are injected at runtime by applyThemeCss(); waiting for one
  // of them confirms the CSS pipeline finished, not just the bundle.
  await page.waitForFunction(
    () => {
      const value = getComputedStyle(document.documentElement).getPropertyValue("--bg-base").trim()
      return value.length > 0
    },
    null,
    { timeout: 30_000 },
  )
}

test("worktree-tooltip", async ({ page }) => {
  test.setTimeout(120_000)

  // Light mode first — direct navigation is fine, we don't depend on app state.
  await page.goto("/")
  await waitForThemeBoot(page)
  await mountTooltip(page)
  const lightShot: Shot = {
    name: "light",
    buf: await page.locator('[data-component="tooltip"]').screenshot(),
  }

  // Dark mode — use the same storage + reload path the real app uses.
  await applyDarkModeForTests(page)
  await waitForThemeBoot(page)
  await mountTooltip(page)
  const darkShot: Shot = {
    name: "dark",
    buf: await page.locator('[data-component="tooltip"]').screenshot(),
  }

  const out = snapOutputPath("worktree-tooltip")
  await composeGrid([lightShot, darkShot], out)
  process.stdout.write(`\n[snap] worktree-tooltip grid -> ${out}\n\n`)
})
