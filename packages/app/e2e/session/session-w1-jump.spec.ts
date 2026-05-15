import type { Page } from "@playwright/test"
import { test, expect } from "../fixtures"
import { withSession } from "../actions"
import { scrollViewportSelector, sessionTurnListSelector } from "../selectors"

type Sdk = Parameters<typeof withSession>[0]

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
  await withSession(project.sdk, "w1 jump spec", async (session) => {
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

    // Scroll to top so the dock surfaces the jump button (jump = true
    // requires overflow + distance > threshold). Then assert the button is
    // truly visible — the wrapper applies opacity-0 / scale-95 / translate
    // in the hidden state, so toBeVisible covers all three.
    await scrollTimelineToTop(page)
    const jumpButton = page.locator('button[aria-label="Jump to latest"]')
    await expect(jumpButton).toBeVisible()

    // Geometry — preview L263-271 / L1066 locks 30 × 30. Read CSS rather
    // than boundingBox so the parent's scale transform during transition
    // does not skew the measurement.
    const dims = await jumpButton.evaluate((el) => {
      const cs = window.getComputedStyle(el)
      return { width: cs.width, height: cs.height, cursor: cs.cursor }
    })
    expect(dims.width).toBe(`${JUMP_BUTTON_SIZE_PX}px`)
    expect(dims.height).toBe(`${JUMP_BUTTON_SIZE_PX}px`)

    // Cursor — preview L267 locks cursor: pointer.
    expect(dims.cursor).toBe("pointer")

    // Hover background — preview L269 layers a 4% overlay over
    // --surface-raised. The hover class is bg-row-hover-overlay, which maps
    // to the theme variable that flips correctly between light/dark via
    // :root[data-color-scheme]. Light theme resolves to rgba(0, 0, 0, 0.04).
    await jumpButton.hover()
    await expect
      .poll(
        () => jumpButton.evaluate((el) => window.getComputedStyle(el).backgroundColor),
        { timeout: 2_000 },
      )
      .toBe("rgba(0, 0, 0, 0.04)")
    await page.mouse.move(0, 0)

    // Dark theme parity — flip data-color-scheme (the source of truth that
    // Settings → Appearance writes) and re-hover. The overlay must follow
    // the app attribute, not OS prefers-color-scheme, hence the white
    // overlay even though Playwright defaults to a light OS preference.
    await page.evaluate(() => {
      document.documentElement.dataset.colorScheme = "dark"
    })
    await jumpButton.hover()
    await expect
      .poll(
        () => jumpButton.evaluate((el) => window.getComputedStyle(el).backgroundColor),
        { timeout: 2_000 },
      )
      .toBe("rgba(255, 255, 255, 0.04)")
    await page.evaluate(() => {
      delete document.documentElement.dataset.colorScheme
    })
    await page.mouse.move(0, 0)

    // Click — should scroll the timeline back to the bottom.
    await jumpButton.click()
    await expect
      .poll(async () => (await timelineDistanceFromBottom(page)) ?? Infinity, { timeout: 5_000 })
      .toBeLessThanOrEqual(8)
  })
})
