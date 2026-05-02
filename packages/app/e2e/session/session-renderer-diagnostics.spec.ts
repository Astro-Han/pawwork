import type { Page } from "@playwright/test"
import { test, expect } from "../fixtures"
import { withSession } from "../actions"
import {
  promptSelector,
  scrollViewportSelector,
  sessionMessageItemSelector,
  sessionTurnListSelector,
} from "../selectors"
import { createSdk } from "../utils"

type Sdk = ReturnType<typeof createSdk>

type CapturedDiagnosticEvent = {
  name: string
  route_session_id?: string
  visible_session_id?: string
  timeline_session_id?: string
  trace_id?: string
  data?: Record<string, unknown>
}

type TimelineMetrics = {
  top: number
  height: number
  client: number
  distanceFromBottom: number
}

async function installRendererDiagnosticsCapture(page: Page) {
  await page.addInitScript(() => {
    const win = window as typeof window & {
      __pawwork_renderer_diagnostics?: CapturedDiagnosticEvent[]
      api?: {
        emitRendererDiagnostic?: (event: CapturedDiagnosticEvent) => Promise<void>
      }
    }
    win.__pawwork_renderer_diagnostics = []
    win.api = {
      ...(win.api ?? {}),
      emitRendererDiagnostic: async (event) => {
        win.__pawwork_renderer_diagnostics?.push(JSON.parse(JSON.stringify(event)))
      },
    }
  })
}

async function readRendererDiagnostics(page: Page) {
  return page.evaluate(() => {
    const win = window as typeof window & {
      __pawwork_renderer_diagnostics?: CapturedDiagnosticEvent[]
    }
    return win.__pawwork_renderer_diagnostics ?? []
  }) as Promise<CapturedDiagnosticEvent[]>
}

async function seedSessionTurns(input: { sdk: Sdk; sessionID: string; count: number }) {
  for (let i = 0; i < input.count; i++) {
    await input.sdk.session.promptAsync({
      sessionID: input.sessionID,
      noReply: true,
      parts: [
        {
          type: "text",
          text: `diagnostics seed ${i}\n${Array.from({ length: 16 }, (_, line) => `line ${line} ${"content ".repeat(8)}`).join("\n")}`,
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

async function scrollTimelineToBottom(page: Page) {
  const found = await page.evaluate(
    ({ scrollViewportSelector, turnListSelector }) => {
      const list = document.querySelector(turnListSelector)
      const viewport = list?.closest(scrollViewportSelector)
      if (!(viewport instanceof HTMLElement)) return false
      viewport.scrollTop = viewport.scrollHeight
      viewport.dispatchEvent(new Event("scroll", { bubbles: true }))
      return true
    },
    { scrollViewportSelector, turnListSelector: sessionTurnListSelector },
  )
  expect(found, "session timeline viewport should exist").toBe(true)
}

async function sendVisiblePrompt(input: { page: Page; text: string }) {
  const prompt = input.page.locator(promptSelector)
  await expect(prompt).toBeVisible()
  await prompt.click()
  await input.page.keyboard.insertText(input.text)
  await expect.poll(async () => (await prompt.textContent())?.replace(/\u200B/g, "").trim()).toBe(input.text)
  await input.page.keyboard.press("Enter")
}

function numberData(event: CapturedDiagnosticEvent, key: string) {
  const value = event.data?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

test("captures renderer diagnostics while guarding send scroll position", async ({ page, project }) => {
  test.setTimeout(120_000)

  await installRendererDiagnosticsCapture(page)
  await project.open()
  const sdk = project.sdk

  await withSession(sdk, `e2e renderer diagnostics ${Date.now()}`, async (session) => {
    project.trackSession(session.id)
    await seedSessionTurns({ sdk, sessionID: session.id, count: 18 })

    await project.gotoSession(session.id)
    await expect(page.locator(sessionMessageItemSelector)).toHaveCount(10, { timeout: 30_000 })
    await scrollTimelineToBottom(page)
    await expect.poll(async () => (await expectTimelineMetrics(page)).distanceFromBottom).toBeLessThan(40)

    const scrollAnchorBefore = await page
      .locator(sessionMessageItemSelector)
      .last()
      .evaluate((item) => (item instanceof HTMLElement ? item.dataset.messageId : null))
    const metricsBefore = await expectTimelineMetrics(page)
    const beforeCount = await page.locator(sessionMessageItemSelector).count()

    await sendVisiblePrompt({ page, text: `diagnostics guard ${Date.now()}` })
    await expect(page.locator(sessionMessageItemSelector)).toHaveCount(beforeCount + 1, { timeout: 30_000 })
    await expect.poll(async () => (await expectTimelineMetrics(page)).distanceFromBottom).toBeLessThan(80)

    const metricsAfter = await expectTimelineMetrics(page)
    const scrollAnchorAfter = await page
      .locator(sessionMessageItemSelector)
      .nth(beforeCount - 1)
      .evaluate((item) => (item instanceof HTMLElement ? item.dataset.messageId : null))
    expect(scrollAnchorBefore).not.toBeNull()
    expect(scrollAnchorAfter).toBe(scrollAnchorBefore)
    expect(Math.abs(metricsAfter.top - metricsBefore.top)).toBeLessThan(200)

    const events = await readRendererDiagnostics(page)
    expect(events.some((event) => event.name === "session.action.submit")).toBe(true)
    expect(events.some((event) => event.name === "session.timeline.mount")).toBe(true)
    expect(events.some((event) => event.name === "session.timeline.visible")).toBe(true)
    expect(events.filter((event) => event.name === "session.timeline.mount")).toHaveLength(1)
    expect(events.filter((event) => event.name === "session.timeline.unmount")).toHaveLength(0)
    expect(events.filter((event) => event.name.startsWith("incident."))).toEqual([])

    const visibleCounts = events
      .filter((event) => event.name === "session.timeline.visible")
      .map((event) => numberData(event, "rendered_count") ?? 0)
    expect(Math.min(...visibleCounts)).toBeGreaterThan(0)
    expect(
      events.some((event) => event.name === "session.scroll.sample" && event.data?.user_scrolled === false),
    ).toBe(true)
  })
})
