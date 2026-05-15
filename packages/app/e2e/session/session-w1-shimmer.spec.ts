import { test, expect } from "../fixtures"

const SHIMMER_NODE = '[data-slot="text-shimmer-char-shimmer"][data-run="true"]'
const EXPECTED_DURATION_MS = 1800

function parseCssDurationMs(raw: string): number {
  const trimmed = raw.trim()
  let value: number
  if (trimmed.endsWith("ms")) value = parseFloat(trimmed)
  else if (trimmed.endsWith("s")) value = parseFloat(trimmed) * 1000
  else throw new Error(`unrecognized CSS duration unit: ${raw}`)
  if (Number.isNaN(value)) throw new Error(`CSS duration parsed to NaN: ${raw}`)
  return value
}

test("session w1 shimmer runs at preview-locked 1800ms with reduced-motion guard", async ({
  page,
  llm,
  project,
}) => {
  await project.open()

  await llm.toolHang("bash", { command: "sleep 9999", description: "w1 shimmer probe" })

  await project.prompt("Run a long-hanging probe to hold a tool in running state.")

  const shimmer = page.locator(SHIMMER_NODE).first()
  await expect(shimmer).toBeVisible({ timeout: 30_000 })

  const reducedMotion = await page.evaluate(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  )
  expect(reducedMotion).toBe(false)

  const durationRaw = await shimmer.evaluate((el) => window.getComputedStyle(el).animationDuration)
  const parsedMs = parseCssDurationMs(durationRaw)
  expect(Math.abs(parsedMs - EXPECTED_DURATION_MS)).toBeLessThan(2)
})
