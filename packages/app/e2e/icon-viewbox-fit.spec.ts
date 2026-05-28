/**
 * icon-viewbox-fit.spec.ts @smoke
 *
 * Static compliance check: every glyph in packages/ui/src/components/icon.tsx
 * must render inside the `0 0 20 20` viewBox. The chrome icon registry stores
 * each glyph as an inner `<g transform=...>` that re-positions a traced path
 * into the shared 20x20 canvas; a mis-fit transform leaves part of the glyph
 * outside the viewport, and the svg's UA `overflow: hidden` then clips it on
 * screen.
 *
 * Originally added with the `read-file` refit — that glyph extended to y≈22.1
 * (clipped at the bottom). This test renders each icon, calls the browser's
 * native `getBBox`, and asserts the bounding box stays within `[0, 20]` so a
 * future port that overshoots a side is caught before it ships.
 *
 * No app server / opencode backend required: the spec only uses
 * `page.setContent` to evaluate SVG geometry in chromium.
 */
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { test, expect } from "@playwright/test"

const here = dirname(fileURLToPath(import.meta.url))
const iconRegistry = resolve(here, "../../ui/src/components/icon.tsx")

function loadIcons(): Record<string, string> {
  const src = readFileSync(iconRegistry, "utf8")
  const startIdx = src.indexOf("export const icons = {")
  if (startIdx < 0) throw new Error("icon registry export not found")
  const body = src.slice(startIdx)
  const out: Record<string, string> = {}
  const re = /"([\w-]+)":\s*`([\s\S]*?)`,/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) out[m[1]] = m[2]
  return out
}

// 1-unit margin is the design contract noted at the top of icon.tsx; we lock
// the harder 0-20 bound so the test fails only on real clipping, not on
// glyphs that hug the keyshape edge.
const VIEWBOX_LOW = 0
const VIEWBOX_HIGH = 20
const EPSILON = 0.05

test("@smoke every chrome icon fits inside the 0..20 viewBox", async ({ page }) => {
  const icons = loadIcons()
  const names = Object.keys(icons)
  expect(names.length, "icon registry should expose at least one glyph").toBeGreaterThan(0)

  await page.setContent('<!doctype html><html><body><div id="stage"></div></body></html>')

  const measurements = await page.evaluate((iconMap) => {
    const ns = "http://www.w3.org/2000/svg"
    const stage = document.getElementById("stage")!
    const results: Array<{ name: string; x: number; y: number; w: number; h: number } | { name: string; error: string }> = []
    for (const [name, inner] of Object.entries(iconMap)) {
      const svg = document.createElementNS(ns, "svg")
      svg.setAttribute("viewBox", "0 0 20 20")
      svg.setAttribute("width", "200")
      svg.setAttribute("height", "200")
      svg.innerHTML = inner
      stage.appendChild(svg)
      try {
        const bbox = svg.getBBox()
        results.push({ name, x: bbox.x, y: bbox.y, w: bbox.width, h: bbox.height })
      } catch (e) {
        results.push({ name, error: String(e) })
      }
      stage.removeChild(svg)
    }
    return results
  }, icons)

  const overflow = measurements
    .map((entry) => {
      if ("error" in entry) {
        return `${entry.name}: getBBox threw ${entry.error}`
      }
      const x1 = entry.x + entry.w
      const y1 = entry.y + entry.h
      const sides: string[] = []
      if (entry.x < VIEWBOX_LOW - EPSILON) sides.push(`left ${entry.x.toFixed(2)}`)
      if (entry.y < VIEWBOX_LOW - EPSILON) sides.push(`top ${entry.y.toFixed(2)}`)
      if (x1 > VIEWBOX_HIGH + EPSILON) sides.push(`right ${x1.toFixed(2)}`)
      if (y1 > VIEWBOX_HIGH + EPSILON) sides.push(`bottom ${y1.toFixed(2)}`)
      if (!sides.length) return null
      return `${entry.name}: ${sides.join(", ")} (bbox x:[${entry.x.toFixed(2)},${x1.toFixed(2)}] y:[${entry.y.toFixed(2)},${y1.toFixed(2)}])`
    })
    .filter((line): line is string => line !== null)

  expect(overflow, `icons overflowing the 0..20 viewBox:\n${overflow.join("\n")}`).toEqual([])
})
