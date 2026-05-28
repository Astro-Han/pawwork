/**
 * icon-viewbox.snap.ts
 *
 * Visual audit for the chrome icon registry's viewBox fit. The registry stores
 * each glyph as an inner `<g transform=...>` that re-positions a traced path
 * into a shared `0 0 20 20` canvas; a transform that overshoots leaves part of
 * the glyph outside the viewport and the svg's UA `overflow: hidden` clips it.
 *
 * The grid shows `read-file` rendered with both its pre-fix and post-fix
 * transform, plus its v4 batchmates `skill` and `thinking` for reference. A
 * red dashed outline marks the `0..20` viewBox edge so any overshoot is
 * immediately visible — `read-file (before)` extends past the bottom edge,
 * the other three sit cleanly inside with ~1-unit margin.
 *
 * Static-data snap: no app shell, no opencode backend. The test mounts a
 * self-contained HTML stage via `page.setContent` and screenshots a locator.
 */
import { icons } from "@opencode-ai/ui/icon"
import { test } from "../fixtures"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

// Pre-fix transform — captured here for the historical comparison; do NOT
// mirror future icon.tsx changes here. This is the "before" state that the
// snap exists to prevent regressing back to.
const READ_FILE_BEFORE_TRANSFORM = "translate(-5.7316 36.8284) scale(0.011675 -0.011675)"

function withTransform(glyph: string, transform: string): string {
  return glyph.replace(/^<g[^>]*>/, `<g transform="${transform}">`)
}

test.use({ viewport: { width: 920, height: 380 }, deviceScaleFactor: 2 })

test("snap: icon viewBox fit (read-file before/after, skill/thinking reference)", async ({ page }) => {
  const readFileNow = icons["read-file"]
  const readFileBefore = withTransform(readFileNow, READ_FILE_BEFORE_TRANSFORM)
  const skill = icons["skill"]
  const thinking = icons["thinking"]

  const cell = (label: string, inner: string, badge?: string) => `
    <div class="cell">
      <div class="canvas">
        <svg viewBox="0 0 20 20" width="220" height="220" aria-hidden="true">${inner}</svg>
        <div class="edge" aria-hidden="true"></div>
        ${badge ? `<div class="badge">${badge}</div>` : ""}
      </div>
      <div class="lbl">${label}</div>
    </div>`

  const html = `<!doctype html><html><head><style>
    html, body { margin: 0; background: #f8f8f8; }
    body {
      font: 13px -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
      color: #333;
      padding: 28px;
    }
    [data-snap-stage] {
      display: flex;
      flex-direction: column;
      gap: 18px;
      align-items: flex-start;
    }
    .row { display: flex; gap: 24px; }
    .cell { display: flex; flex-direction: column; align-items: center; gap: 8px; }
    .canvas { position: relative; width: 220px; height: 220px; background: #fff; }
    .canvas svg { display: block; color: #2f2f2f; }
    .edge {
      position: absolute; inset: 0;
      border: 1px dashed #d33;
      pointer-events: none;
    }
    .badge {
      position: absolute; top: 6px; right: 6px;
      padding: 2px 6px;
      background: #d33; color: #fff;
      font-size: 11px; font-weight: 600;
      border-radius: 3px;
    }
    .lbl { font-size: 12px; color: #555; letter-spacing: 0.2px; }
    .heading { font-size: 12px; color: #888; letter-spacing: 0.4px; text-transform: uppercase; margin-bottom: -4px; }
  </style></head><body>
    <div data-snap-stage>
      <div class="heading">read-file · before vs after</div>
      <div class="row">
        ${cell("before (overshoots bottom)", readFileBefore, "clipped")}
        ${cell("after (centered, 1u margin)", readFileNow)}
      </div>
      <div class="heading">batchmates for reference</div>
      <div class="row">
        ${cell("skill", skill)}
        ${cell("thinking", thinking)}
      </div>
    </div>
  </body></html>`

  await page.setContent(html)
  const stage = page.locator("[data-snap-stage]")
  await stage.waitFor({ state: "visible", timeout: 10_000 })
  // Give the browser one frame to layout the four svg canvases.
  await page.waitForFunction(() => document.querySelectorAll("svg").length === 4)
  const buf = await stage.screenshot()

  const shots: Shot[] = [{ name: "icon-viewbox", buf }]
  await composeGrid(shots, snapOutputPath("icon-viewbox"), { cols: 1 })
})
