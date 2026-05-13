import { test, expect } from "../fixtures"

/**
 * Slice 11b.1 — issue #440 §5.2 P0 #6 retest 4 (AstroHan msg=ac13481a /
 * GPT-X RCA msg=d60ff75a).
 *
 * Regression gate for the trow-toggle layout interaction: expanding a
 * long trow used to surface an off-bottom round → next `content_resize`
 * from the agent's append → the scroll controller's
 * `following_latest` branch snapped the viewport to bottom (or, if the
 * round was nowhere near bottom, the message-level anchor restore
 * snapped to the user-turn top). The minimal patch threads a
 * `layout_interaction` intent from `<TrowBlock>` summary's
 * `onPointerDown` through `MessageTimeline` → `onTimelineScrollIntent`
 * → controller `intent("layout_interaction")`, flipping mode to
 * `reading_history` and pausing the autoScroll owner so the
 * subsequent content_resize preserves the local reading position.
 *
 * The test reproduces the regression scenario behaviourally:
 *   1. Stage a long trow + an off-bottom scroll position.
 *   2. Click the trow summary (fires layout_interaction).
 *   3. Trigger an agent append (content_resize).
 *   4. Assert scrollTop stayed inside a "reading" range — it did not
 *      snap to 0 (user-turn top) and did not snap to scrollHeight -
 *      clientHeight (bottom).
 */

const SCROLLER = '[data-slot="message-timeline-scroller"]'
const TROW_SUMMARY = '[data-component="session-turn-trow-block"] summary'

test("@regression P0 #6 — trow toggle + agent append keeps viewport in reading position", async ({
  page,
  llm,
  project,
}) => {
  test.setTimeout(120_000)
  await project.open()

  // Stage a long trow (so the round has real height to scroll past)
  // followed by a chunk of prose that we will continue appending later.
  for (let i = 0; i < 8; i++) {
    await llm.tool("bash", { command: `echo ${i}`, description: `cmd ${i}` })
  }
  await llm.text(
    [
      "First the agent emits a long paragraph so the round overshoots",
      "the viewport. The user then scrolls back up into history before",
      "the agent appends more content, which is the regression scenario.",
    ].join(" "),
  )

  await project.prompt("P0 #6 regression — long trow + scroll-back + append")

  const trowSummary = page.locator(TROW_SUMMARY).first()
  await expect(trowSummary).toBeVisible({ timeout: 60_000 })

  // Scroll the viewport up into the middle of the round so the
  // controller is in `reading_history`. We use the actual scroller
  // element so the wheel gesture goes through the timeline.
  const scroller = page.locator(SCROLLER).first()
  await scroller.waitFor({ state: "attached" })
  await scroller.evaluate((el) => {
    el.scrollTop = Math.max(0, Math.floor(el.scrollHeight * 0.4))
  })

  const before = await scroller.evaluate((el) => ({
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }))

  // Click the summary — this fires `layout_interaction` *before* the
  // <details> toggle runs.
  await trowSummary.click()

  // Trigger an agent append that will land a `content_resize` while
  // the user is still reading the expanded trow.
  await llm.text("Tail prose appended after the user expanded the trow.")

  // Give the renderer a moment to apply the content_resize.
  await page.waitForTimeout(800)

  const after = await scroller.evaluate((el) => ({
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }))

  // Hard regression assertions: the viewport must NOT have snapped to
  // either edge.
  //
  // - `scrollTop !== 0`: the message-level anchor restore used to
  //   yank the viewport to the user-turn top.
  // - `distanceFromBottom > 16`: the `following_latest` branch used
  //   to call `restore_latest` and pin the viewport flush against the
  //   bottom edge.
  expect(after.scrollTop).toBeGreaterThan(0)
  const distanceFromBottom = after.scrollHeight - after.scrollTop - after.clientHeight
  expect(distanceFromBottom).toBeGreaterThan(16)

  // Soft assertion: the local reading position did not drift more
  // than a "viewport's worth" away from where the user was reading.
  // A small delta is acceptable because the expanded trow body itself
  // changed the height around the anchor; what we forbid is a jump to
  // an edge.
  const drift = Math.abs(after.scrollTop - before.scrollTop)
  expect(drift).toBeLessThan(after.clientHeight)
})
