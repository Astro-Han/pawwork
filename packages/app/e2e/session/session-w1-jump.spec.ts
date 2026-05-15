import type { Page } from "@playwright/test"
import { test, expect } from "../fixtures"
import { cleanupSession } from "../actions"
import { scrollViewportSelector, sessionTurnListSelector } from "../selectors"

type Sdk = Parameters<typeof cleanupSession>[0]["sdk"]

const JUMP_BUTTON_SIZE_PX = 30

async function seedSessionTurns(input: { sdk: Sdk; sessionID: string; count: number }) {
  for (let i = 0; i < input.count; i++) {
    await input.sdk.session.promptAsync({
      sessionID: input.sessionID,
      noReply: true,
      parts: [
        {
          type: "text",
          text: `w1 jump seed ${i}\n${Array.from({ length: 16 }, (_, line) => `line ${line} ${"content ".repeat(8)}`).join("\n")}`,
        },
      ],
    })
  }
}

async function scrollTimelineToTop(page: Page) {
  return page.evaluate(
    ({ scrollViewportSelector, turnListSelector }) => {
      const list = document.querySelector(turnListSelector)
      const viewport = list?.closest(scrollViewportSelector)
      if (!(viewport instanceof HTMLElement)) return false
      viewport.scrollTop = 0
      viewport.dispatchEvent(new Event("scroll", { bubbles: true }))
      return true
    },
    { scrollViewportSelector, turnListSelector: sessionTurnListSelector },
  )
}

async function timelineDistanceFromBottom(page: Page) {
  return page.evaluate(
    ({ scrollViewportSelector, turnListSelector }) => {
      const list = document.querySelector(turnListSelector)
      const viewport = list?.closest(scrollViewportSelector)
      if (!(viewport instanceof HTMLElement)) return null
      return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop
    },
    { scrollViewportSelector, turnListSelector: sessionTurnListSelector },
  ) as Promise<number | null>
}

test("session w1 jump-to-bottom button matches W1-locked geometry and click behaviour", async ({
  page,
  project,
}) => {
  await project.open()
  const session = await project.sdk.session.create({ title: "w1 jump spec" }).then((r) => r.data)
  if (!session?.id) throw new Error("Session create did not return an id")

  try {
    await seedSessionTurns({ sdk: project.sdk, sessionID: session.id, count: 12 })
    await project.gotoSession(session.id)
    await expect(page.locator(sessionTurnListSelector)).toBeVisible()

    // Wait for messages to render and the timeline to grow past the jump
    // threshold (clientHeight + 400 per use-session-scroll-dock.ts).
    await expect
      .poll(
        async () => {
          const m = await page.evaluate(
            ({ scrollViewportSelector, turnListSelector }) => {
              const list = document.querySelector(turnListSelector)
              const viewport = list?.closest(scrollViewportSelector)
              if (!(viewport instanceof HTMLElement)) return null
              return { scrollHeight: viewport.scrollHeight, clientHeight: viewport.clientHeight }
            },
            { scrollViewportSelector, turnListSelector: sessionTurnListSelector },
          )
          if (!m) return 0
          return m.scrollHeight - m.clientHeight
        },
        { timeout: 15_000 },
      )
      .toBeGreaterThan(450)

    // The button is always present in the DOM (just transformed off-screen
    // when the timeline is at bottom). Geometry assertions read CSS rather
    // than boundingBox so they are not affected by the scale-95 hidden state.
    const jumpButton = page.locator('button[aria-label="Jump to latest"]')
    await expect(jumpButton).toBeAttached()

    // Geometry — preview L263-271 / L1066 locks 30 × 30.
    const dims = await jumpButton.evaluate((el) => {
      const cs = window.getComputedStyle(el)
      return { width: cs.width, height: cs.height, cursor: cs.cursor }
    })
    expect(dims.width).toBe(`${JUMP_BUTTON_SIZE_PX}px`)
    expect(dims.height).toBe(`${JUMP_BUTTON_SIZE_PX}px`)

    // Cursor — preview L267 locks cursor: pointer.
    expect(dims.cursor).toBe("pointer")

    // Hover background — preview L269 layers a 4% black overlay over
    // --surface-raised. We force the :hover class via hover() and read
    // computed background-image; gradient stack must appear (not `none`).
    await jumpButton.hover({ force: true })
    const hoverBackgroundImage = await jumpButton.evaluate(
      (el) => window.getComputedStyle(el).backgroundImage,
    )
    expect(hoverBackgroundImage).toContain("linear-gradient")
    await page.mouse.move(0, 0)

    // Click — should scroll the timeline back to the bottom. Use scrollTo
    // first to put the timeline somewhere off the bottom, then click and
    // expect the dock to pull it back.
    await scrollTimelineToTop(page)
    await jumpButton.click({ force: true })
    await expect
      .poll(async () => (await timelineDistanceFromBottom(page)) ?? -1, { timeout: 5_000 })
      .toBeLessThanOrEqual(8)
  } finally {
    await cleanupSession({ sdk: project.sdk, sessionID: session.id })
  }
})
