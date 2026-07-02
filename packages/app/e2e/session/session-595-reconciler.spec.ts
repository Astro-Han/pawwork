import type { Page } from "@playwright/test"
import { test, expect } from "../fixtures"
import { withSession } from "../actions"
import { scrollViewportSelector, sessionMessageItemSelector, sessionTurnListSelector } from "../selectors"

// Issue #595 — the scroll reconciler is the single app-level authoritative
// writer. These two specs are the root-cause repros that the prior incremental
// attempt (PR #916) could not hold: once the user is reading history, a content
// or layout change at the bottom must NOT snap the viewport back to the latest
// turn. Both drive the real user path (native wheel gesture, real DOM resize)
// and assert the reading anchor stays pinned across the layout change.

type Sdk = Parameters<typeof withSession>[0]

const INITIAL_SESSION_WINDOW_MESSAGES = 10

type TimelineMetrics = {
  top: number
  height: number
  client: number
  distanceFromBottom: number
}

type TimelineScrollSample = TimelineMetrics & { at: number }

type CapturedPageError = { type: string; message: string }

async function seedSessionTurns(input: { sdk: Sdk; sessionID: string; count: number }) {
  for (let i = 0; i < input.count; i++) {
    await input.sdk.session.promptAsync({
      sessionID: input.sessionID,
      noReply: true,
      parts: [
        {
          type: "text",
          text: `595 seed turn ${i}\n${Array.from({ length: 16 }, (_, line) => `line ${line} ${"content ".repeat(8)}`).join("\n")}`,
        },
      ],
    })
  }
}

function timelineMetrics(page: Page) {
  return page.evaluate(
    ({ scrollViewportSelector, turnListSelector }) => {
      const list = document.querySelector(turnListSelector)
      const viewport = list?.closest(scrollViewportSelector)
      if (!(viewport instanceof HTMLElement)) return null
      return {
        top: viewport.scrollTop,
        height: viewport.scrollHeight,
        client: viewport.clientHeight,
        distanceFromBottom: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
      }
    },
    { scrollViewportSelector, turnListSelector: sessionTurnListSelector },
  ) as Promise<TimelineMetrics | null>
}

async function expectTimelineMetrics(page: Page) {
  const metrics = await timelineMetrics(page)
  expect(metrics, "session timeline viewport should exist").not.toBeNull()
  return metrics!
}

async function viewportBox(page: Page) {
  const box = await page.evaluate(
    ({ scrollViewportSelector, turnListSelector }) => {
      const list = document.querySelector(turnListSelector)
      const viewport = list?.closest(scrollViewportSelector)
      if (!(viewport instanceof HTMLElement)) return null
      const rect = viewport.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    },
    { scrollViewportSelector, turnListSelector: sessionTurnListSelector },
  )
  expect(box, "session timeline viewport should exist").not.toBeNull()
  return box!
}

// The first fully-visible message and its offset below the viewport top — the
// message the reader's eye is on, and the position the reconciler must keep.
async function readingAnchorOffset(page: Page) {
  return page.evaluate(
    ({ scrollViewportSelector, turnListSelector, messageSelector }) => {
      const list = document.querySelector(turnListSelector)
      const viewport = list?.closest(scrollViewportSelector)
      if (!(viewport instanceof HTMLElement)) return null
      const viewportTop = viewport.getBoundingClientRect().top
      for (const node of Array.from(document.querySelectorAll(messageSelector))) {
        if (!(node instanceof HTMLElement)) continue
        const offset = node.getBoundingClientRect().top - viewportTop
        if (offset >= 0) return { id: node.dataset.messageId ?? "", offset }
      }
      return null
    },
    { scrollViewportSelector, turnListSelector: sessionTurnListSelector, messageSelector: sessionMessageItemSelector },
  ) as Promise<{ id: string; offset: number } | null>
}

async function anchorOffsetByID(page: Page, anchorID: string) {
  return page.evaluate(
    ({ scrollViewportSelector, turnListSelector, anchorID }) => {
      const list = document.querySelector(turnListSelector)
      const viewport = list?.closest(scrollViewportSelector)
      if (!(viewport instanceof HTMLElement)) return null
      const node = document.querySelector(`[data-message-id="${anchorID}"]`)
      if (!(node instanceof HTMLElement)) return null
      return { offset: node.getBoundingClientRect().top - viewport.getBoundingClientRect().top }
    },
    { scrollViewportSelector, turnListSelector: sessionTurnListSelector, anchorID },
  ) as Promise<{ offset: number } | null>
}

async function scrollTimelineToBottom(page: Page) {
  const found = await page.evaluate(
    ({ scrollViewportSelector, turnListSelector }) => {
      const list = document.querySelector(turnListSelector)
      const viewport = list?.closest(scrollViewportSelector)
      if (!(viewport instanceof HTMLElement)) return false
      viewport.scrollTop = viewport.scrollHeight
      return true
    },
    { scrollViewportSelector, turnListSelector: sessionTurnListSelector },
  )
  expect(found, "session timeline viewport should exist").toBe(true)
}

// Drive a real upward wheel gesture over the timeline until the viewport has
// left the bottom. page.mouse.wheel dispatches a genuine wheel event, so this
// exercises the same onWheel → upward-intent → reading path a user would. Each
// tick is followed by a wait so the trailing scroll event samples the reading
// anchor in reading mode (the host captures the anchor on the scroll that
// accompanies the gesture, not on the wheel itself).
async function wheelUpIntoReading(page: Page, target: number) {
  const box = await viewportBox(page)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let attempt = 0; attempt < 16; attempt++) {
    const metrics = await timelineMetrics(page)
    if (metrics && metrics.distanceFromBottom >= target) {
      // A couple of small settle ticks so a reading-mode scroll sample lands
      // and the reconciler stores a reading anchor before we rely on it.
      await page.mouse.wheel(0, -120)
      await page.waitForTimeout(150)
      await page.mouse.wheel(0, -120)
      await page.waitForTimeout(150)
      return
    }
    await page.mouse.wheel(0, -400)
    await page.waitForTimeout(120)
  }
  await expect.poll(async () => (await expectTimelineMetrics(page)).distanceFromBottom).toBeGreaterThanOrEqual(target)
}

async function installTimelineScrollProbe(page: Page) {
  await page.evaluate(
    ({ maxSamples, scrollViewportSelector, turnListSelector }) => {
      const read = () => {
        const list = document.querySelector(turnListSelector)
        const viewport = list?.closest(scrollViewportSelector)
        if (!(viewport instanceof HTMLElement)) return null
        return {
          at: performance.now(),
          top: viewport.scrollTop,
          height: viewport.scrollHeight,
          client: viewport.clientHeight,
          distanceFromBottom: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
        }
      }
      const samples: NonNullable<ReturnType<typeof read>>[] = []
      const push = () => {
        const next = read()
        if (next && samples.length < maxSamples) samples.push(next)
      }
      push()
      let frame = requestAnimationFrame(function tick() {
        push()
        frame = requestAnimationFrame(tick)
      })
      const viewport = document.querySelector(turnListSelector)?.closest(scrollViewportSelector)
      if (viewport instanceof HTMLElement) viewport.addEventListener("scroll", push, { passive: true })
      const win = window as typeof window & {
        __opencode_e2e?: Record<string, unknown> & { timeline595Probe?: { stop: () => unknown } }
      }
      win.__opencode_e2e = {
        ...(win.__opencode_e2e ?? {}),
        timeline595Probe: {
          stop() {
            cancelAnimationFrame(frame)
            if (viewport instanceof HTMLElement) viewport.removeEventListener("scroll", push)
            push()
            delete win.__opencode_e2e?.timeline595Probe
            return samples
          },
        },
      }
    },
    { maxSamples: 512, scrollViewportSelector, turnListSelector: sessionTurnListSelector },
  )
}

async function stopTimelineScrollProbe(page: Page) {
  return page.evaluate(() => {
    const win = window as typeof window & {
      __opencode_e2e?: { timeline595Probe?: { stop: () => unknown } }
    }
    const probe = win.__opencode_e2e?.timeline595Probe
    if (!probe) throw new Error("timeline 595 probe was not installed")
    return probe.stop()
  }) as Promise<TimelineScrollSample[]>
}

function collectPageErrors(page: Page) {
  const errors: CapturedPageError[] = []
  const handler = (error: Error) => {
    if (error.message === "ResizeObserver loop completed with undelivered notifications.") return
    errors.push({ type: "pageerror", message: error.stack || error.message })
  }
  page.on("pageerror", handler)
  return { errors, dispose: () => page.off("pageerror", handler) }
}

test("does not snap to the latest turn when content grows while reading history", async ({ page, project }) => {
  test.setTimeout(120_000)

  const pageErrors = collectPageErrors(page)
  await project.open()
  const sdk = project.sdk

  await withSession(sdk, `e2e 595 read-grow ${Date.now()}`, async (session) => {
    project.trackSession(session.id)
    await seedSessionTurns({ sdk, sessionID: session.id, count: 16 })

    await project.gotoSession(session.id)
    await expect(page.locator(sessionMessageItemSelector)).toHaveCount(INITIAL_SESSION_WINDOW_MESSAGES, {
      timeout: 30_000,
    })
    await scrollTimelineToBottom(page)
    await expect.poll(async () => (await expectTimelineMetrics(page)).distanceFromBottom).toBeLessThan(20)

    // The user wheels up to read older output. Any upward gesture must leave
    // follow mode immediately (the #595 root-cause fix).
    await wheelUpIntoReading(page, 200)
    expect((await expectTimelineMetrics(page)).distanceFromBottom).toBeGreaterThanOrEqual(200)

    // Anchor on the message the user is reading and remember where it sits in
    // the viewport. Under virtualization scrollTop is not a stable coordinate
    // (virtua re-estimates row sizes as turns append), so the meaningful
    // invariant is that the read message keeps its viewport offset.
    const before = await readingAnchorOffset(page)
    expect(before, "expected a fully-visible reading anchor").not.toBeNull()

    // Now the agent keeps producing turns at the bottom. Each append grows
    // scrollHeight and fires a content resize — the exact event that used to
    // yank the viewport back to the latest turn.
    await installTimelineScrollProbe(page)
    let samples: TimelineScrollSample[] = []
    try {
      for (let i = 0; i < 4; i++) {
        await seedSessionTurns({ sdk, sessionID: session.id, count: 1 })
        await page.waitForTimeout(150)
      }
      // Give the reconciler a few frames to settle after the last append.
      await page.waitForTimeout(300)
    } finally {
      samples = await stopTimelineScrollProbe(page)
    }

    const after = await anchorOffsetByID(page, before!.id)
    expect(after, "reading anchor should stay mounted as turns append").not.toBeNull()

    // The read message keeps its place across the appends — re-pinned, not
    // dragged down with the growing content and not snapped to the bottom.
    expect(Math.abs(after!.offset - before!.offset)).toBeLessThan(60)

    const settled = await expectTimelineMetrics(page)
    expect(settled.distanceFromBottom).toBeGreaterThan(150)

    // No transient snap either: the bug surfaced as a frame where the tall
    // timeline jumped to the bottom (top high, distanceFromBottom ~0).
    const snaps = samples.filter(
      (sample) => sample.height > sample.client + 200 && sample.distanceFromBottom < 20,
    )
    expect(snaps).toEqual([])
  })

  expect(pageErrors.errors).toEqual([])
  pageErrors.dispose()
})

test("keeps the reading anchor pinned across a content reflow", async ({ page, project }) => {
  test.setTimeout(120_000)

  const pageErrors = collectPageErrors(page)
  await project.open()
  const sdk = project.sdk

  await withSession(sdk, `e2e 595 reflow ${Date.now()}`, async (session) => {
    project.trackSession(session.id)
    await seedSessionTurns({ sdk, sessionID: session.id, count: 16 })

    await project.gotoSession(session.id)
    await expect(page.locator(sessionMessageItemSelector)).toHaveCount(INITIAL_SESSION_WINDOW_MESSAGES, {
      timeout: 30_000,
    })
    await scrollTimelineToBottom(page)
    await expect.poll(async () => (await expectTimelineMetrics(page)).distanceFromBottom).toBeLessThan(20)

    await wheelUpIntoReading(page, 250)
    await expect.poll(async () => (await expectTimelineMetrics(page)).distanceFromBottom).toBeGreaterThanOrEqual(250)

    // Anchor on the first fully-visible message and remember where it sits in
    // the viewport. The reconciler must keep this offset stable across the
    // reflow, not let the content above it push it around (the tool-row-expand
    // scrollHeight thrash signature).
    const before = await readingAnchorOffset(page)
    expect(before, "expected a fully-visible reading anchor").not.toBeNull()

    const initial = page.viewportSize() ?? { width: 1280, height: 720 }
    await installTimelineScrollProbe(page)
    let samples: TimelineScrollSample[] = []
    try {
      // Narrowing the window rewraps the long message text — a real mid-list
      // scrollHeight change while the user is reading.
      await page.setViewportSize({ width: Math.round(initial.width * 0.6), height: initial.height })
      await page.waitForTimeout(400)
    } finally {
      samples = await stopTimelineScrollProbe(page)
    }

    const after = await anchorOffsetByID(page, before!.id)
    expect(after, "reading anchor should stay mounted across the reflow").not.toBeNull()

    // The anchor keeps roughly the same viewport offset — it is re-pinned, not
    // dragged by the reflow above it and not snapped to the bottom.
    expect(Math.abs(after!.offset - before!.offset)).toBeLessThan(80)

    const settled = await expectTimelineMetrics(page)
    expect(settled.distanceFromBottom).toBeGreaterThan(100)
    const snaps = samples.filter(
      (sample) => sample.height > sample.client + 200 && sample.distanceFromBottom < 20,
    )
    expect(snaps).toEqual([])

    await page.setViewportSize(initial)
  })

  expect(pageErrors.errors).toEqual([])
  pageErrors.dispose()
})
