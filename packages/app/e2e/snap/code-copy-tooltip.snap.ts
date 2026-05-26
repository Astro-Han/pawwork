import { expect } from "@playwright/test"
import { fileURLToPath } from "node:url"
import { test } from "../fixtures"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 480, height: 220 }, deviceScaleFactor: 2 })

// The copy button and its tooltip are injected by markdown post-processing
// (ensureCodeWrapper + setupCodeCopy), not by a Solid component, so we drive
// those helpers directly instead of standing up the full Markdown context.
// The code block sits inside a narrow overflow:hidden box that mimics the
// message stream: the regression we guard is the tooltip getting clipped at the
// stream's edge. With the fixed body tooltip it must float clear of the box.
const toolsPath = fileURLToPath(new URL("../../../ui/src/components/markdown-code-tools.ts", import.meta.url))

async function waitForThemeBoot(page: import("@playwright/test").Page): Promise<void> {
  await page.waitForFunction(
    () => getComputedStyle(document.documentElement).getPropertyValue("--bg-base").trim().length > 0,
    null,
    { timeout: 30_000 },
  )
}

test("code-copy-tooltip", async ({ page }) => {
  test.setTimeout(120_000)

  await page.goto("/")
  await waitForThemeBoot(page)

  await page.evaluate(async (path) => {
    const mod = await import(path)
    const labels = { copy: "复制到剪贴板", copied: "已复制" }

    const stream = document.createElement("div")
    Object.assign(stream.style, {
      position: "relative",
      overflow: "hidden",
      width: "320px",
      margin: "72px auto 0",
      padding: "12px",
      borderRadius: "10px",
      background: "var(--surface-base)",
      boxShadow: "var(--shadow-floating)",
    })

    const markdown = document.createElement("div")
    markdown.setAttribute("data-component", "markdown")
    const pre = document.createElement("pre")
    const code = document.createElement("code")
    code.textContent = "const total = items.reduce((a, b) => a + b, 0)\nconsole.log(total)"
    pre.appendChild(code)
    markdown.appendChild(pre)
    stream.appendChild(markdown)

    document.body.innerHTML = ""
    document.body.appendChild(stream)

    mod.ensureCodeWrapper(pre, labels)
    mod.setupCodeCopy(markdown, () => labels)
  }, `/@fs/${toolsPath}`)

  const block = page.locator('[data-component="markdown-code"]')
  await block.hover()
  const button = page.locator('[data-slot="markdown-copy-button"]')
  await button.waitFor({ state: "visible", timeout: 30_000 })

  // Button only: confirms the borderless icon-button affordance on hover.
  const buttonShot: Shot = { name: "button", buf: await page.screenshot() }

  // Tooltip: hovering the button floats the label above it, clear of the box's
  // overflow:hidden clip.
  await button.hover()
  const tooltip = page.locator('[data-slot="markdown-copy-tooltip"][data-show="true"]')
  await tooltip.waitFor({ state: "visible", timeout: 30_000 })
  // Wait out the 0.15s opacity fade-in so the screenshot isn't captured
  // mid-transition, which would make the visual snapshot flaky.
  await expect.poll(() => tooltip.evaluate((el) => getComputedStyle(el).opacity), { timeout: 5_000 }).toBe("1")
  const tooltipShot: Shot = { name: "tooltip", buf: await page.screenshot() }

  const out = snapOutputPath("code-copy-tooltip")
  await composeGrid([buttonShot, tooltipShot], out, { cols: 2 })
  process.stdout.write(`\n[snap] code-copy-tooltip grid -> ${out}\n\n`)
})
