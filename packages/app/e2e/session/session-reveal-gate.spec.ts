import type { Page } from "@playwright/test"
import { test, expect } from "../fixtures"
import { withSession } from "../actions"
import { sessionMessageItemSelector } from "../selectors"

// Reveal gate (follow-latest open) — opening or switching to a session that is
// pinned to the latest turn must not expose the mid-render "premature bottom"
// the virtualizer lands on before it finishes measuring tall content. The
// timeline mounts and measures behind the opening cover; the cover only lifts
// once the reconciler has gone quiet, so the first *visible* frame is already
// the settled bottom. This drives the real navigation path and asserts the
// invariant on the frames the user could actually see.

type Sdk = Parameters<typeof withSession>[0]

const INITIAL_SESSION_WINDOW_MESSAGES = 10
// A revealed (visible) frame must already sit at the bottom; small sub-pixel /
// padding slack only.
const BOTTOM_TOLERANCE = 24
// Across all revealed frames scrollTop must be effectively constant — the bug
// surfaced as a viewport-sized downward jump (hundreds of px), so anything past
// this gate is the regression, not settle jitter.
const JUMP_TOLERANCE = 48

type RevealSample = {
  at: number
  top: number
  height: number
  client: number
  distanceFromBottom: number
  covered: boolean
}

async function seedSessionTurns(input: { sdk: Sdk; sessionID: string; count: number }) {
  for (let i = 0; i < input.count; i++) {
    await input.sdk.session.promptAsync({
      sessionID: input.sessionID,
      noReply: true,
      parts: [
        {
          type: "text",
          text: `reveal seed turn ${i}\n${Array.from({ length: 16 }, (_, line) => `line ${line} ${"content ".repeat(8)}`).join("\n")}`,
        },
      ],
    })
  }
}

// Install a per-frame probe via addInitScript so it survives the full page
// navigation `gotoSession` performs and captures from the very first frame of
// the session route. Each frame records the timeline scroll position plus
// whether the reveal cover is up (`data-covered`); when the wrapper is absent
// (pre-fix DOM) every frame counts as visible.
const REVEAL_PROBE_SCRIPT = `(() => {
  const TURN_LIST = '[data-slot="session-turn-list"]'
  const VIEWPORT = '[data-component="scroll-viewport"]'
  const REVEAL = '[data-slot="session-timeline-reveal"]'
  const samples = []
  const read = () => {
    const list = document.querySelector(TURN_LIST)
    const viewport = list && list.closest(VIEWPORT)
    if (!(viewport instanceof HTMLElement)) return null
    const reveal = document.querySelector(REVEAL)
    const covered = reveal instanceof HTMLElement ? reveal.getAttribute('data-covered') === 'true' : false
    return {
      at: performance.now(),
      top: viewport.scrollTop,
      height: viewport.scrollHeight,
      client: viewport.clientHeight,
      distanceFromBottom: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
      covered,
    }
  }
  const push = () => { const s = read(); if (s && samples.length < 4000) samples.push(s) }
  const tick = () => { push(); requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
  window.__revealProbe = { snapshot: () => samples.slice() }
})()`

function readRevealSamples(page: Page) {
  return page.evaluate(() => {
    const probe = (window as unknown as { __revealProbe?: { snapshot: () => RevealSample[] } }).__revealProbe
    return probe ? probe.snapshot() : []
  }) as Promise<RevealSample[]>
}

test("does not expose a premature-bottom jump when opening a follow-latest session", async ({ page, project }) => {
  test.setTimeout(120_000)

  await project.open()
  const sdk = project.sdk

  await withSession(sdk, `e2e reveal-gate ${Date.now()}`, async (session) => {
    project.trackSession(session.id)
    await seedSessionTurns({ sdk, sessionID: session.id, count: 16 })

    // Probe from frame 0 of the upcoming session navigation.
    await page.addInitScript(REVEAL_PROBE_SCRIPT)
    await project.gotoSession(session.id)

    await expect(page.locator(sessionMessageItemSelector)).toHaveCount(INITIAL_SESSION_WINDOW_MESSAGES, {
      timeout: 30_000,
    })
    // Let the open fully settle so the probe captures the reveal transition and
    // any trailing re-pin.
    await page.waitForTimeout(1000)

    const samples = await readRevealSamples(page)
    expect(samples.length, "reveal probe should have captured frames").toBeGreaterThan(0)

    // Only frames with real overflow matter; an empty/short timeline cannot jump.
    const overflowing = samples.filter((sample) => sample.height > sample.client + 200)
    expect(overflowing.length, "expected the seeded timeline to overflow").toBeGreaterThan(0)

    const visible = overflowing.filter((sample) => !sample.covered)
    expect(visible.length, "the timeline should become visible").toBeGreaterThan(0)

    // Every frame the user could see is already at the settled bottom — the
    // premature mid-render bottom is never painted.
    const offBottom = visible.filter((sample) => sample.distanceFromBottom > BOTTOM_TOLERANCE)
    expect(offBottom, "no visible frame may sit off the settled bottom").toEqual([])

    // And visible scrollTop never jumps — the premature→true bottom correction
    // happens entirely behind the cover.
    const tops = visible.map((sample) => sample.top)
    expect(Math.max(...tops) - Math.min(...tops), "visible scrollTop must not jump").toBeLessThanOrEqual(
      JUMP_TOLERANCE,
    )

    // Sanity that the gate actually engaged (rather than the open settling so
    // fast there was nothing to cover): the cover held for at least one frame.
    expect(overflowing.some((sample) => sample.covered), "the reveal cover should hold during the open").toBe(true)
  })
})
