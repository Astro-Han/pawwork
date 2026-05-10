import type { Page } from "@playwright/test"
import { test, expect } from "../fixtures"
import { withSession } from "../actions"
import {
  promptSelector,
  scrollThumbSelector,
  scrollViewSelector,
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

function directoryCompareKey(directory: string | undefined) {
  if (!directory) return ""
  const value = directory.replaceAll("\\", "/").replace(/\/+$/, "") || "/"
  return value.startsWith("/private/var/") ? value.slice("/private".length) : value
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
    const originalEmit = win.api?.emitRendererDiagnostic?.bind(win.api)
    win.api = {
      ...(win.api ?? {}),
      emitRendererDiagnostic: async (event) => {
        win.__pawwork_renderer_diagnostics?.push(JSON.parse(JSON.stringify(event)))
        await originalEmit?.(event)
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

async function scrollTimelineToOffset(page: Page, top: number) {
  const found = await page.evaluate(
    ({ scrollViewportSelector, turnListSelector, top }) => {
      const list = document.querySelector(turnListSelector)
      const viewport = list?.closest(scrollViewportSelector)
      if (!(viewport instanceof HTMLElement)) return false
      viewport.scrollTop = top
      viewport.dispatchEvent(new Event("scroll", { bubbles: true }))
      return true
    },
    { scrollViewportSelector, turnListSelector: sessionTurnListSelector, top },
  )
  expect(found, "session timeline viewport should exist").toBe(true)
}

async function resetTimelineToTop(page: Page) {
  const found = await page.evaluate(
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
  expect(found, "session timeline viewport should exist").toBe(true)
}

async function markTimelinePointerGesture(page: Page) {
  const found = await page.evaluate(
    ({ scrollViewportSelector, turnListSelector }) => {
      const list = document.querySelector(turnListSelector)
      const viewport = list?.closest(scrollViewportSelector)
      if (!(viewport instanceof HTMLElement)) return false
      viewport.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          pointerId: 1,
        }),
      )
      return true
    },
    { scrollViewportSelector, turnListSelector: sessionTurnListSelector },
  )
  expect(found, "session timeline viewport should exist").toBe(true)
}

async function timelineThumbBox(page: Page) {
  return page.evaluate(
    ({ scrollThumbSelector, scrollViewSelector, scrollViewportSelector, turnListSelector }) => {
      const list = document.querySelector(turnListSelector)
      const viewport = list?.closest(scrollViewportSelector)
      const root = viewport?.closest(scrollViewSelector)
      const thumb = root?.querySelector(scrollThumbSelector)
      if (!(thumb instanceof HTMLElement)) return null
      const rect = thumb.getBoundingClientRect()
      return {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      }
    },
    { scrollThumbSelector, scrollViewSelector, scrollViewportSelector, turnListSelector: sessionTurnListSelector },
  )
}

async function holdTimelineThumbDragBy(page: Page, deltaY: number) {
  const box = await timelineThumbBox(page)
  expect(box, "session timeline thumb should exist").not.toBeNull()
  const x = box!.x + box!.width / 2
  const y = box!.y + Math.min(box!.height / 2, 12)
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, y + deltaY, { steps: 8 })
}

async function dragTimelineThumbBy(page: Page, deltaY: number) {
  await holdTimelineThumbDragBy(page, deltaY)
  await page.mouse.up()
}

async function waitForTimelineFrame(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      }),
  )
}

async function sendVisiblePrompt(input: { page: Page; text: string }) {
  const prompt = input.page.locator(promptSelector)
  await expect(prompt).toBeVisible()
  await prompt.click()
  await prompt.fill("")
  await prompt.fill(input.text)
  await expect.poll(async () => (await prompt.textContent())?.replace(/\u200B/g, "").trim()).toBe(input.text)
  await input.page.keyboard.press("Enter")
}

async function expandRenderedTimeline(page: Page, target: number) {
  const viewport = page.locator(scrollViewportSelector).first()
  await expect(viewport).toBeVisible()
  await expect
    .poll(
      async () => {
        const count = await page.locator(sessionMessageItemSelector).count()
        if (count >= target) return count
        await viewport.hover()
        await page.mouse.wheel(0, -2400)
        return page.locator(sessionMessageItemSelector).count()
      },
      { timeout: 30_000 },
    )
    .toBeGreaterThanOrEqual(target)
}

async function readPromptSent(page: Page) {
  return page.evaluate(() => {
    const win = window as typeof window & {
      __opencode_e2e?: {
        prompt?: {
          sent?: {
            started?: number
            count?: number
            sessionID?: string
            directory?: string
          }
        }
      }
    }
    const sent = win.__opencode_e2e?.prompt?.sent
    return {
      started: sent?.started ?? 0,
      count: sent?.count ?? 0,
      sessionID: sent?.sessionID,
      directory: sent?.directory,
    }
  })
}

async function waitSessionActiveDirectory(input: { sdk: Sdk; sessionID: string; directory: string }) {
  await expect
    .poll(
      async () => {
        const session = await input.sdk.session.get({ sessionID: input.sessionID }).then((res) => res.data)
        return directoryCompareKey(session?.executionContext.activeDirectory)
      },
      { timeout: 45_000 },
    )
    .toBe(directoryCompareKey(input.directory))
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
    const promptText = `diagnostics guard ${Date.now()}`
    await sendVisiblePrompt({ page, text: promptText })
    await expect(page.locator(sessionMessageItemSelector).last()).toContainText(promptText, { timeout: 30_000 })
    await markTimelinePointerGesture(page)
    await resetTimelineToTop(page)
    await expect.poll(async () => (await expectTimelineMetrics(page)).distanceFromBottom).toBeLessThan(80)

    const metricsAfter = await expectTimelineMetrics(page)
    const scrollAnchorAfter = await page.locator(sessionTurnListSelector).evaluate((list, id) => {
      if (!(list instanceof HTMLElement) || !id) return null
      return Array.from(list.querySelectorAll("[data-message-id]")).some(
        (item) => item instanceof HTMLElement && item.dataset.messageId === id,
      )
        ? id
        : null
    }, scrollAnchorBefore)
    expect(scrollAnchorBefore).not.toBeNull()
    expect(scrollAnchorAfter).toBe(scrollAnchorBefore)
    expect(metricsAfter.distanceFromBottom).toBeLessThan(80)

    const events = await readRendererDiagnostics(page)
    expect(events.some((event) => event.name === "session.action.submit")).toBe(true)
    expect(
      events.some(
        (event) =>
          event.name === "session.timeline.scroll_controller" &&
          event.data?.accepted === false &&
          event.data?.reason === "submit_restore_latest_after_top_reset",
      ),
    ).toBe(true)
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

test("honors scrollbar thumb drag after submit instead of restoring latest", async ({ page, project }) => {
  test.setTimeout(120_000)

  await installRendererDiagnosticsCapture(page)
  await project.open()
  const sdk = project.sdk

  await withSession(sdk, `e2e scrollbar drag latest ${Date.now()}`, async (session) => {
    project.trackSession(session.id)
    await seedSessionTurns({ sdk, sessionID: session.id, count: 18 })

    await project.gotoSession(session.id)
    await expect(page.locator(sessionMessageItemSelector)).toHaveCount(10, { timeout: 30_000 })
    await scrollTimelineToBottom(page)
    await expect.poll(async () => (await expectTimelineMetrics(page)).distanceFromBottom).toBeLessThan(40)

    const promptText = `scrollbar drag guard ${Date.now()}`
    await sendVisiblePrompt({ page, text: promptText })
    await expect(page.locator(sessionMessageItemSelector).last()).toContainText(promptText, { timeout: 30_000 })

    await holdTimelineThumbDragBy(page, -180)
    try {
      await resetTimelineToTop(page)
      await expect
        .poll(async () => {
          const events = await readRendererDiagnostics(page)
          return events.some(
            (event) =>
              event.name === "session.timeline.scroll_controller" &&
              event.data?.observation_type === "scroll_sample" &&
              event.data?.near_top === true,
          )
        })
        .toBe(true)
      await waitForTimelineFrame(page)
      await expect.poll(async () => (await expectTimelineMetrics(page)).distanceFromBottom).toBeGreaterThan(200)
    } finally {
      await page.mouse.up().catch(() => {})
    }

    const events = await readRendererDiagnostics(page)
    const dragIndex = events.findIndex(
      (event) =>
        event.name === "session.timeline.scroll_controller" && event.data?.intent_type === "scrollbar_drag_start",
    )
    expect(dragIndex).toBeGreaterThanOrEqual(0)
    expect(
      events
        .slice(dragIndex)
        .some(
          (event) =>
            event.name === "session.timeline.scroll_controller" &&
            event.data?.accepted === false &&
            event.data?.reason === "submit_restore_latest_after_top_reset",
        ),
    ).toBe(false)
    expect(
      events
        .slice(dragIndex)
        .some(
          (event) =>
            event.name === "session.scroll.sample" &&
            event.data?.user_scrolled === true &&
            (numberData(event, "distance_from_bottom") ?? 0) > 200,
        ),
    ).toBe(true)

    await dragTimelineThumbBy(page, 10_000)
    await expect.poll(async () => (await expectTimelineMetrics(page)).distanceFromBottom).toBeLessThan(80)
  })
})

test("keeps long timeline stable across worktree exit follow-up", async ({ page, project, llm }) => {
  test.setTimeout(180_000)

  await installRendererDiagnosticsCapture(page)
  await project.open()
  const sdk = project.sdk

  await withSession(sdk, `e2e long timeline worktree ${Date.now()}`, async (session) => {
    project.trackSession(session.id)
    await seedSessionTurns({ sdk, sessionID: session.id, count: 90 })

    await project.gotoSession(session.id)
    await expect(page.locator(sessionMessageItemSelector)).toHaveCount(10, { timeout: 30_000 })
    await expandRenderedTimeline(page, 80)
    await scrollTimelineToOffset(page, 240)
    await expect.poll(async () => (await expectTimelineMetrics(page)).top).toBeGreaterThan(20)

    const created = await sdk.worktree.create({ directory: project.directory }).then((res) => res.data)
    if (!created?.directory) throw new Error("Failed to create worktree for long timeline diagnostics")
    const worktreeDirectory = created.directory
    project.trackDirectory(worktreeDirectory)

    await llm.tool("enter-worktree", { path: worktreeDirectory })
    await sendVisiblePrompt({ page, text: "enter diagnostics worktree" })
    await waitSessionActiveDirectory({ sdk, sessionID: session.id, directory: worktreeDirectory })
    await expect
      .poll(async () => page.locator(sessionMessageItemSelector).count(), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(80)

    await llm.tool("exit-worktree", {})
    await sendVisiblePrompt({ page, text: "exit diagnostics worktree" })
    await waitSessionActiveDirectory({ sdk, sessionID: session.id, directory: project.directory })
    await expect
      .poll(async () => page.locator(sessionMessageItemSelector).count(), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(80)
    await expect.poll(async () => (await expectTimelineMetrics(page)).top).toBeGreaterThan(20)

    const followupCheckpoint = (await readRendererDiagnostics(page)).length
    const sentBeforeFollowup = await readPromptSent(page)
    const followupText = `worktree exit follow-up ${Date.now()}`
    await sendVisiblePrompt({ page, text: followupText })
    await expect
      .poll(async () => page.locator(sessionMessageItemSelector).count(), { timeout: 30_000 })
      .toBeGreaterThanOrEqual(80)

    await expect
      .poll(
        async () => {
          const messages = await sdk.session.messages({ sessionID: session.id, limit: 200 }).then((res) => res.data ?? [])
          return {
            count: messages.length,
            hasFollowup: messages.some((message) =>
              message.parts.some((part) => part.type === "text" && part.text.includes(followupText)),
            ),
          }
        },
        { timeout: 30_000 },
      )
      .toEqual({ count: expect.any(Number), hasFollowup: true })

    const messages = await sdk.session.messages({ sessionID: session.id, limit: 200 }).then((res) => res.data ?? [])
    expect(messages.length).toBeGreaterThanOrEqual(91)

    const sent = await readPromptSent(page)
    expect(sent.count).toBeGreaterThan(sentBeforeFollowup.count)
    expect(sent.sessionID).toBe(session.id)
    expect(sent.directory).toBe(project.directory)

    const events = await readRendererDiagnostics(page)
    const sessionEvents = events.filter((event) => event.timeline_session_id === session.id)
    expect(sessionEvents.filter((event) => event.name === "session.timeline.mount")).toHaveLength(1)
    expect(sessionEvents.filter((event) => event.name === "session.timeline.unmount")).toHaveLength(0)
    expect(sessionEvents.filter((event) => event.name === "session.identity.transition")).toHaveLength(0)

    const followupEvents = events.slice(followupCheckpoint).filter((event) => event.timeline_session_id === session.id)
    const followupVisibleCounts = followupEvents
      .filter((event) => event.name === "session.timeline.visible")
      .map((event) => numberData(event, "rendered_count") ?? 0)
    if (followupVisibleCounts.length > 0) expect(Math.max(...followupVisibleCounts)).toBeGreaterThanOrEqual(80)

    const followupScrollJumps = followupEvents.filter((event) => {
      if (event.name !== "session.scroll.sample") return false
      const top = numberData(event, "scroll_top")
      const distance = numberData(event, "distance_from_bottom")
      return top !== undefined && distance !== undefined && top < 20 && distance > 100
    })
    expect(followupScrollJumps).toEqual([])

    const viewMessageCounts = events
      .filter((event) => event.name === "session.view.state" && event.timeline_session_id === session.id)
      .map((event) => numberData(event, "message_count") ?? 0)
    expect(Math.max(...viewMessageCounts)).toBeGreaterThanOrEqual(91)
  })
})
