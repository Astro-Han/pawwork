import type { Locator } from "@playwright/test"
import { test, expect } from "../fixtures"
import { sessionIDFromUrl } from "../actions"
import { promptSelector } from "../selectors"

// W1 renderer contracts that the local handtest still re-checks by eye but that
// are cheap to lock with computed-style + presence assertions (issue #598,
// scope A behaviour + scope B computed styles). Scroll behaviours (A.1/A.2) are
// already covered by the scroll-controller unit tests plus the weak-wheel E2E
// in session-renderer-diagnostics.spec.ts, so they are intentionally out of
// scope here. The full nested-wheel isolation (A.3) keeps its unit coverage in
// session-timeline-scroll-intents.test.ts; this spec only locks the DOM
// precondition (the bounded, scrollable raw-output container). The user-bubble
// hairline (scope B.1) is dropped: the bubble has since moved to a fill-only
// treatment (surface-interactive-base / surface-raised, 14px radius, no border
// or inset box-shadow), so the W1 hairline contract is stale.

const TROW_BLOCK = '[data-component="session-turn-trow-block"]'
const TROW_SUMMARY = `${TROW_BLOCK} [data-slot="trow-summary"]`
const TROW_CHEVRON = `${TROW_BLOCK} [data-slot="trow-summary-chev"]`
const TROW_RESULT_BODY = `${TROW_BLOCK} [data-slot="trow-result-body"]`
const TROW_INNER_TRIGGER = `${TROW_BLOCK} [data-slot="trow-body"] [data-component="tool-trigger"]`
const BASH_SCROLL = `${TROW_BLOCK} [data-slot="bash-scroll"]`
const THINKING = '[data-slot="session-turn-thinking"]'
const USER_TEXT = '[data-component="user-message"] [data-slot="user-message-text"]'
const AGENT_PROSE = '[data-component="text-part"]'
const AGENT_REASONING = '[data-component="reasoning-body"]'

function rotationDeg(transform: string): number {
  if (!transform || transform === "none") return 0
  const match = transform.match(/matrix\(([^)]+)\)/)
  if (!match) return Number.NaN
  const [a, b] = match[1].split(",").map((value) => Number(value.trim()))
  return Math.round((Math.atan2(b, a) * 180) / Math.PI)
}

function detailsOpen(summary: Locator): Promise<boolean> {
  return summary.evaluate((el) => (el.closest("details") as HTMLDetailsElement | null)?.open ?? false)
}

test("@smoke W1 rendered turn locks chevron, selectability, and trow typography", async ({
  page,
  project,
  assistant,
}) => {
  test.setTimeout(120_000)
  await project.open()

  // One turn that renders every W1 surface this spec asserts on: a user bubble
  // (prompt), a multi-part trow (tool + reasoning, so groupParts keeps them
  // consecutive and the <details> chevron appears) and agent prose. The bash
  // round runs first so the tool and reasoning parts stay adjacent — a text
  // part between them would split the trow group.
  await assistant.tool("bash", {
    command: "echo w1-trow-contract",
    description: "W1 trow contract probe",
  })
  await assistant.reason("Checking the W1 rendered-turn contracts before replying.", {
    text: "Finished probing the W1 rendered-turn contracts.",
  })
  await project.prompt("Probe the rendered-turn W1 contracts.")

  await expect(page.locator(USER_TEXT)).toBeVisible()
  await expect(page.locator(AGENT_PROSE)).toBeVisible()
  await expect(page.locator(TROW_BLOCK).first()).toBeVisible()

  await test.step("chevron is 12px and rotates collapsed-right / open-down", async () => {
    const summary = page.locator(TROW_SUMMARY).first()
    const chevron = page.locator(TROW_CHEVRON).first()
    await expect(chevron).toBeAttached()

    // Default-collapsed (DESIGN.md L468); normalise to a known collapsed start
    // in case a future default flips it.
    if (await detailsOpen(summary)) {
      await summary.click()
      await expect.poll(() => detailsOpen(summary)).toBe(false)
    }

    const geometry = await chevron.evaluate((el) => {
      const cs = window.getComputedStyle(el)
      const icon = el.querySelector("[data-icon]")
      const iconCs = icon ? window.getComputedStyle(icon) : null
      return { width: cs.width, height: cs.height, iconWidth: iconCs?.width, iconHeight: iconCs?.height }
    })
    expect(geometry.width).toBe("12px")
    expect(geometry.height).toBe("12px")
    expect(geometry.iconWidth).toBe("12px")
    expect(geometry.iconHeight).toBe("12px")
    await expect
      .poll(async () => rotationDeg(await chevron.evaluate((el) => window.getComputedStyle(el).transform)))
      .toBe(-90)

    await summary.click()
    await expect.poll(() => detailsOpen(summary)).toBe(true)
    await expect
      .poll(async () => rotationDeg(await chevron.evaluate((el) => window.getComputedStyle(el).transform)))
      .toBe(0)
  })

  await test.step("expand the trow rows so the reasoning and raw-output bodies mount", async () => {
    // reasoning-body and bash-output mount lazily inside each row's collapsible,
    // so the open <details> alone is not enough — expand every inner row.
    const triggers = page.locator(TROW_INNER_TRIGGER)
    const count = await triggers.count()
    expect(count).toBeGreaterThan(1)
    for (let index = 0; index < count; index++) await triggers.nth(index).click()
    await expect(page.locator(AGENT_REASONING)).toBeVisible()
    await expect(page.locator(BASH_SCROLL)).toBeVisible()
  })

  await test.step("user bubble, agent prose, and agent reasoning keep text selectable", async () => {
    for (const selector of [USER_TEXT, AGENT_PROSE, AGENT_REASONING]) {
      const value = await page.locator(selector).first().evaluate((el) => window.getComputedStyle(el).userSelect)
      expect(value, selector).toBe("text")
    }
  })

  await test.step("trow result body uses the mono-small + fg-weak tokens with no sans leakage", async () => {
    // Resolve the design tokens through throwaway probe nodes so the assertion
    // tracks the token contract, not whatever literal value the tokens map to.
    const tokens = await page.evaluate(() => {
      const measure = (declarations: Record<string, string>) => {
        const node = document.createElement("div")
        for (const [property, value] of Object.entries(declarations)) node.style.setProperty(property, value)
        document.documentElement.appendChild(node)
        const cs = window.getComputedStyle(node)
        const out = { fontFamily: cs.fontFamily, fontSize: cs.fontSize, color: cs.color }
        node.remove()
        return out
      }
      return {
        mono: measure({
          "font-family": "var(--font-family-mono)",
          "font-size": "var(--font-size-mono-small)",
          color: "var(--fg-weak)",
        }),
        sans: measure({ "font-family": "var(--font-family-sans)" }),
      }
    })

    const body = await page.locator(TROW_RESULT_BODY).first().evaluate((el) => {
      const cs = window.getComputedStyle(el)
      return { fontFamily: cs.fontFamily, fontSize: cs.fontSize, color: cs.color }
    })
    expect(body.fontFamily).toBe(tokens.mono.fontFamily)
    expect(body.fontFamily).not.toBe(tokens.sans.fontFamily)
    expect(body.fontSize).toBe(tokens.mono.fontSize)
    expect(body.color).toBe(tokens.mono.color)
  })

  await test.step("raw tool output is a bounded scrollable container (nested-isolation precondition)", async () => {
    // Full wheel-isolation behaviour is unit-covered; here we only lock the DOM
    // contract the isolation logic keys off: the raw output is a [data-scrollable]
    // container with its own bounded height, so a gesture inside it can be kept
    // off the parent timeline.
    const scroll = page.locator(BASH_SCROLL).first()
    await expect(scroll).toHaveAttribute("data-scrollable", "")
    const box = await scroll.evaluate((el) => {
      const cs = window.getComputedStyle(el)
      return { maxHeight: cs.maxHeight, overflowY: cs.overflowY }
    })
    expect(box.maxHeight).toBe("240px")
    expect(box.overflowY).toBe("auto")
  })

  await test.step("thinking indicator is gone once the turn has visible parts", async () => {
    await expect(page.locator(THINKING)).toHaveCount(0)
  })
})

test("@smoke W1 thinking indicator shows while the turn is working with nothing visible", async ({
  page,
  project,
  assistant,
}) => {
  test.setTimeout(120_000)
  await project.open()
  await assistant.hang()

  // Submit by hand: project.prompt() waits for the session to go idle, which
  // never happens while the reply hangs. Type + Enter and only wait for the
  // thinking shimmer to surface.
  const text = "Hold the turn open with nothing rendered yet."
  const prompt = page.locator(promptSelector).first()
  await expect(prompt).toBeVisible()
  await prompt.click()
  await prompt.fill("")
  await prompt.fill(text)
  await expect.poll(async () => (await prompt.textContent())?.replace(/\u200B/g, "").trim()).toBe(text)
  await page.keyboard.press("Enter")

  const thinking = page.locator(THINKING)
  await expect(thinking).toBeVisible({ timeout: 30_000 })
  await expect(thinking.locator('[data-component="text-shimmer"]')).toBeVisible()

  // Manual submit bypasses project.prompt(), so register the session the UI
  // created. Otherwise teardown only drops the project directory and leaves the
  // hung stream alive for the rest of the Playwright worker.
  await expect.poll(() => sessionIDFromUrl(page.url()) ?? "").not.toBe("")
  project.trackSession(sessionIDFromUrl(page.url())!)

  // The hang reply is dispatched asynchronously; wait for it to actually reach
  // the test LLM server (queue drains to 0) so teardown does not flag it as an
  // unconsumed queued response.
  await expect.poll(async () => assistant.pending()).toBe(0)
})
