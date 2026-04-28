import type { Page } from "@playwright/test"
import { test, expect } from "../fixtures"
import { withSession } from "../actions"
import {
  promptSelector,
  scrollViewportSelector,
  sessionItemSelector,
  sessionMessageItemSelector,
  sessionTurnListSelector,
} from "../selectors"
import { createSdk } from "../utils"

type Sdk = ReturnType<typeof createSdk>

const INITIAL_SESSION_WINDOW_MESSAGES = 10

type TimelineMetrics = {
  top: number
  height: number
  client: number
  distanceFromBottom: number
}

type TimelineScrollSample = TimelineMetrics & {
  at: number
  url: string
}

function timelineMetrics(page: Page) {
  return page.evaluate(({ scrollViewportSelector, turnListSelector }) => {
    const list = document.querySelector(turnListSelector)
    const viewport = list?.closest(scrollViewportSelector)
    if (!(viewport instanceof HTMLElement)) return null
    return {
      top: viewport.scrollTop,
      height: viewport.scrollHeight,
      client: viewport.clientHeight,
      distanceFromBottom: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
    }
  }, { scrollViewportSelector, turnListSelector: sessionTurnListSelector }) as Promise<TimelineMetrics | null>
}

async function expectTimelineMetrics(page: Page) {
  const metrics = await timelineMetrics(page)
  expect(metrics, "session timeline viewport should exist").not.toBeNull()
  return metrics!
}

async function scrollTimelineToBottom(page: Page) {
  const found = await page.evaluate(({ scrollViewportSelector, turnListSelector }) => {
    const list = document.querySelector(turnListSelector)
    const viewport = list?.closest(scrollViewportSelector)
    if (!(viewport instanceof HTMLElement)) return false
    viewport.scrollTop = viewport.scrollHeight
    return true
  }, { scrollViewportSelector, turnListSelector: sessionTurnListSelector })
  expect(found, "session timeline viewport should exist").toBe(true)
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
          url: window.location.href,
          top: viewport.scrollTop,
          height: viewport.scrollHeight,
          client: viewport.clientHeight,
          distanceFromBottom: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
        }
      }
      const changed = (a: NonNullable<ReturnType<typeof read>>, b: NonNullable<ReturnType<typeof read>>) =>
        a.url !== b.url ||
        a.top !== b.top ||
        a.height !== b.height ||
        a.client !== b.client ||
        a.distanceFromBottom !== b.distanceFromBottom
      const samples: NonNullable<ReturnType<typeof read>>[] = []
      const push = () => {
        const next = read()
        if (!next) return
        const prev = samples[samples.length - 1]
        if (prev && !changed(prev, next)) return
        if (samples.length < maxSamples) samples.push(next)
      }
      push()
      let frame = requestAnimationFrame(function tick() {
        push()
        frame = requestAnimationFrame(tick)
      })
      const observer = new MutationObserver(push)
      observer.observe(document.body, { childList: true, subtree: true })
      const first = read()
      const viewport = first
        ? document.querySelector(turnListSelector)?.closest(scrollViewportSelector)
        : undefined
      if (viewport instanceof HTMLElement) viewport.addEventListener("scroll", push, { passive: true })
      const win = window as typeof window & {
        __opencode_e2e?: Record<string, unknown> & {
          timelineScrollProbe?: { stop: () => unknown }
        }
      }
      win.__opencode_e2e = {
        ...(win.__opencode_e2e ?? {}),
        timelineScrollProbe: {
          stop() {
            cancelAnimationFrame(frame)
            observer.disconnect()
            if (viewport instanceof HTMLElement) viewport.removeEventListener("scroll", push)
            push()
            delete win.__opencode_e2e?.timelineScrollProbe
            return samples
          },
        },
      }
    },
    { maxSamples: 256, scrollViewportSelector, turnListSelector: sessionTurnListSelector },
  )
}

async function stopTimelineScrollProbe(page: Page) {
  return page.evaluate(() => {
    const win = window as typeof window & {
      __opencode_e2e?: {
        timelineScrollProbe?: { stop: () => unknown }
      }
    }
    const probe = win.__opencode_e2e?.timelineScrollProbe
    if (!probe) throw new Error("timeline scroll probe was not installed")
    return probe.stop()
  }) as Promise<TimelineScrollSample[]>
}

async function sendVisiblePrompt(input: { page: Page; text: string }) {
  const prompt = input.page.locator(promptSelector)
  await expect(prompt).toBeVisible()
  await prompt.click()
  await input.page.keyboard.insertText(input.text)
  await expect.poll(async () => (await prompt.textContent())?.replace(/\u200B/g, "").trim()).toBe(input.text)
  await input.page.keyboard.press("Enter")
}

async function seedSessionTurns(input: { sdk: Sdk; sessionID: string; count: number }) {
  for (let i = 0; i < input.count; i++) {
    await input.sdk.session.promptAsync({
      sessionID: input.sessionID,
      noReply: true,
      parts: [
        {
          type: "text",
          text: `seed turn ${i}\n${Array.from({ length: 16 }, (_, line) => `line ${line} ${"content ".repeat(8)}`).join("\n")}`,
        },
      ],
    })
  }
}

async function installMessageCountProbe(page: Page) {
  await page.evaluate(
    ({ maxSamples, messageSelector }) => {
      const read = () => ({
        url: window.location.href,
        messages: document.querySelectorAll(messageSelector).length,
      })
      const samples = [read()]
      const push = () => {
        const next = read()
        const prev = samples[samples.length - 1]
        if (prev && prev.url === next.url && prev.messages === next.messages) return
        if (samples.length < maxSamples) samples.push(next)
      }
      let frame = requestAnimationFrame(function tick() {
        push()
        frame = requestAnimationFrame(tick)
      })
      const observer = new MutationObserver(push)
      observer.observe(document.body, { childList: true, subtree: true })
      const win = window as typeof window & {
        __opencode_e2e?: Record<string, unknown> & {
          messageCountProbe?: { stop: () => unknown }
        }
      }
      win.__opencode_e2e = {
        ...win.__opencode_e2e,
        messageCountProbe: {
          stop() {
            cancelAnimationFrame(frame)
            observer.disconnect()
            push()
            delete win.__opencode_e2e?.messageCountProbe
            return samples
          },
        },
      }
    },
    { maxSamples: 256, messageSelector: sessionMessageItemSelector },
  )
}

async function stopMessageCountProbe(page: Page) {
  return page.evaluate(() => {
    const win = window as typeof window & {
      __opencode_e2e?: {
        messageCountProbe?: { stop: () => unknown }
      }
    }
    const probe = win.__opencode_e2e?.messageCountProbe
    if (!probe) throw new Error("message count probe was not installed")
    return probe.stop()
  }) as Promise<Array<{ url: string; messages: number }>>
}

test("keeps the latest turn in view when sending from an old message hash", async ({ page, project }) => {
  test.setTimeout(120_000)

  await project.open()
  const sdk = project.sdk

  await withSession(sdk, `e2e scroll position ${Date.now()}`, async (session) => {
    project.trackSession(session.id)

    await seedSessionTurns({ sdk, sessionID: session.id, count: 14 })

    await project.gotoSession(session.id)
    await expect(page.locator(sessionMessageItemSelector)).toHaveCount(INITIAL_SESSION_WINDOW_MESSAGES, {
      timeout: 30_000,
    })
    await scrollTimelineToBottom(page)
    await expect.poll(async () => (await expectTimelineMetrics(page)).distanceFromBottom).toBeLessThan(20)

    const ids = await page.locator(sessionMessageItemSelector).evaluateAll((items) =>
      items.map((item) => (item instanceof HTMLElement ? item.dataset.messageId : undefined)).filter(Boolean),
    )
    const oldID = ids[2]
    if (!oldID) throw new Error("expected an older rendered message id")

    await page.goto(`${page.url()}#message-${oldID}`)
    await expect(page.locator(`#message-${oldID}`)).toBeVisible()
    await expect.poll(async () => (await expectTimelineMetrics(page)).distanceFromBottom).toBeGreaterThan(100)

    const token = `scroll_latest_${Date.now()}`
    const beforeCount = await page.locator(sessionMessageItemSelector).count()
    await sendVisiblePrompt({ page, text: `reply with ${token}` })
    await expect(page.locator(sessionMessageItemSelector)).toHaveCount(beforeCount + 1, { timeout: 30_000 })

    await expect.poll(() => page.url()).not.toContain("#message-")
    await expect
      .poll(async () => (await expectTimelineMetrics(page)).distanceFromBottom, { timeout: 30_000 })
      .toBeLessThan(40)
    const rendered = await page.locator(sessionMessageItemSelector).evaluateAll((items) =>
      items.map((item) => (item instanceof HTMLElement ? item.dataset.messageId : undefined)).filter(Boolean),
    )
    expect(rendered.at(-1)).not.toBe(oldID)
  })
})

test("does not jump to the top after sending from an old message hash", async ({ page, project }) => {
  test.setTimeout(120_000)

  await project.open()
  const sdk = project.sdk

  await withSession(sdk, `e2e send top guard ${Date.now()}`, async (session) => {
    project.trackSession(session.id)

    await seedSessionTurns({ sdk, sessionID: session.id, count: 18 })

    await project.gotoSession(session.id)
    await expect(page.locator(sessionMessageItemSelector)).toHaveCount(INITIAL_SESSION_WINDOW_MESSAGES, {
      timeout: 30_000,
    })
    await scrollTimelineToBottom(page)
    await expect.poll(async () => (await expectTimelineMetrics(page)).distanceFromBottom).toBeLessThan(20)

    const ids = await page.locator(sessionMessageItemSelector).evaluateAll((items) =>
      items.map((item) => (item instanceof HTMLElement ? item.dataset.messageId : undefined)).filter(Boolean),
    )
    const oldID = ids[1]
    if (!oldID) throw new Error("expected an older rendered message id")

    await page.goto(`${page.url()}#message-${oldID}`)
    await expect(page.locator(`#message-${oldID}`)).toBeVisible()
    await expect.poll(async () => (await expectTimelineMetrics(page)).distanceFromBottom).toBeGreaterThan(100)

    await installTimelineScrollProbe(page)
    let samples: TimelineScrollSample[] = []
    const sendStartedAt = await page.evaluate(() => performance.now())
    try {
      await sendVisiblePrompt({ page, text: `top guard ${Date.now()}` })
      await expect.poll(() => page.url()).not.toContain("#message-")
      await expect
        .poll(async () => (await expectTimelineMetrics(page)).distanceFromBottom, { timeout: 30_000 })
        .toBeLessThan(40)
    } finally {
      samples = await stopTimelineScrollProbe(page)
    }

    expect(samples.length).toBeGreaterThan(0)
    const relevantSamples = samples.filter((sample) => sample.at >= sendStartedAt)
    expect(relevantSamples.length).toBeGreaterThan(0)
    const topJumps = relevantSamples.filter(
      (sample) =>
        sample.height > sample.client + 100 &&
        sample.top < 20 &&
        sample.distanceFromBottom > 100,
    )
    expect(topJumps).toEqual([])
  })
})

test("renders the full initial session window when switching sessions", async ({ page, project }) => {
  test.setTimeout(120_000)

  await project.open()
  const sdk = project.sdk

  await withSession(sdk, `e2e switch source ${Date.now()}`, async (first) => {
    project.trackSession(first.id)
    await withSession(sdk, `e2e switch target ${Date.now()}`, async (second) => {
      project.trackSession(second.id)
      await seedSessionTurns({ sdk, sessionID: first.id, count: 14 })
      await seedSessionTurns({ sdk, sessionID: second.id, count: 14 })

      await project.gotoSession(first.id)
      await expect(page.locator(sessionMessageItemSelector)).toHaveCount(INITIAL_SESSION_WINDOW_MESSAGES, {
        timeout: 30_000,
      })
      await expect(page.locator(sessionItemSelector(second.id))).toBeVisible({ timeout: 30_000 })

      await installMessageCountProbe(page)
      await page.locator(sessionItemSelector(second.id)).click()
      await expect.poll(() => new URL(page.url()).pathname.endsWith(`/session/${second.id}`)).toBe(true)
      await expect(page.locator(sessionMessageItemSelector)).toHaveCount(INITIAL_SESSION_WINDOW_MESSAGES, {
        timeout: 30_000,
      })
      const samples = await stopMessageCountProbe(page)
      const rendered = await page.locator(sessionMessageItemSelector).evaluateAll((items) =>
        items.map((item) => (item instanceof HTMLElement ? item.dataset.messageId : undefined)).filter(Boolean),
      )
      const secondMessages = await sdk.session.messages({ sessionID: second.id, limit: 100 }).then((r) => r.data ?? [])
      const secondIDs = new Set(secondMessages.map((item) => item.info.id))

      const switched = samples.filter((sample) => sample.url.includes(`/session/${second.id}`))
      expect(switched.length).toBeGreaterThan(0)
      expect(rendered.every((id) => secondIDs.has(id))).toBe(true)
      expect(
        switched.filter(
          (sample) => sample.messages > 0 && sample.messages < INITIAL_SESSION_WINDOW_MESSAGES,
        ),
      ).toEqual([])
    })
  })
})
