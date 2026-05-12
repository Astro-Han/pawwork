import { test, expect } from "../fixtures"
import { promptSelector, scrollViewportSelector, sessionTurnListSelector } from "../selectors"

/**
 * Slice 11b.1 — issue #440 §5.2 E6.
 *
 * Verifies the W1 floating jump-to-bottom button — the new
 * `JumpToBottom` leaf mounted by `message-timeline.tsx` (Phase 2b
 * commit). The button must:
 *
 *   - be invisible while the user is pinned to the bottom;
 *   - appear immediately when the user scrolls up (no "has new
 *     content since unpin" gate, per design doc §3.4);
 *   - scroll the viewport to the bottom on click and re-hide.
 */

const JUMP_BUTTON = '[data-component="session-turn-jump"]'

test("E6 — ↓ button mounts and re-pins the timeline to the bottom on click", async ({
  page,
  llm,
  project,
}) => {
  test.setTimeout(180_000)
  await project.open()

  // Seed enough turns to force overflow.
  for (let i = 0; i < 6; i++) {
    await llm.text(`turn ${i} agent reply with enough text to push the column past the viewport height`)
  }
  for (let i = 0; i < 6; i++) {
    await project.prompt(
      `turn ${i} user message with enough content to take up vertical room ${"a".repeat(120)}`,
    )
  }

  await expect(page.locator(promptSelector)).toBeVisible({ timeout: 60_000 })

  // Scroll the timeline viewport up so the user is no longer pinned.
  await page.evaluate(
    ({ scrollViewportSelector, turnListSelector }) => {
      const list = document.querySelector(turnListSelector)
      const viewport = list?.closest(scrollViewportSelector)
      if (viewport instanceof HTMLElement) viewport.scrollTop = 0
    },
    { scrollViewportSelector, turnListSelector: sessionTurnListSelector },
  )

  await expect(page.locator(JUMP_BUTTON)).toBeVisible({ timeout: 10_000 })

  await page.locator(JUMP_BUTTON).click()

  // After click the viewport should be back near the bottom and the
  // button should hide. We don't pin a literal `distance === 0` —
  // the resume scroll path uses an animated scroll, and re-pin is
  // committed once the user is within the bottom threshold.
  await expect
    .poll(
      async () =>
        await page.evaluate(
          ({ scrollViewportSelector, turnListSelector }) => {
            const list = document.querySelector(turnListSelector)
            const viewport = list?.closest(scrollViewportSelector)
            if (!(viewport instanceof HTMLElement)) return -1
            return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop
          },
          { scrollViewportSelector, turnListSelector: sessionTurnListSelector },
        ),
      { timeout: 15_000 },
    )
    .toBeLessThan(40)

  await expect(page.locator(JUMP_BUTTON)).toBeHidden({ timeout: 10_000 })
})
