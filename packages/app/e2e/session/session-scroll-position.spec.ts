import type { Page } from "@playwright/test"
import { test, expect } from "../fixtures"
import { openSidebar, withSession } from "../actions"
import {
  promptSelector,
  scrollViewportSelector,
  sessionComposerDockSelector,
  sessionItemSelector,
  sessionMessageItemSelector,
  sessionTurnListSelector,
} from "../selectors"
import { createSdk, modKey } from "../utils"

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

type SessionTransitionSample = TimelineMetrics & {
  at: number
  url: string
  routeSessionID?: string
  messageOwners: string[]
  messages: number
  composerDock: number
  composerHeight: number
  messageList: number
  removedComposerDock: boolean
  removedMessageList: boolean
}

type CapturedPageError = {
  type: string
  message: string
  detail?: string
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
      return true
    },
    { scrollViewportSelector, turnListSelector: sessionTurnListSelector },
  )
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
      const viewport = first ? document.querySelector(turnListSelector)?.closest(scrollViewportSelector) : undefined
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

async function sendVisiblePrompt(input: { page: Page; text: string; submitKey?: string }) {
  const prompt = input.page.locator(promptSelector)
  await expect(prompt).toBeVisible()
  await prompt.click()
  await input.page.keyboard.insertText(input.text)
  await expect.poll(async () => (await prompt.textContent())?.replace(/\u200B/g, "").trim()).toBe(input.text)
  await input.page.keyboard.press(input.submitKey ?? "Enter")
}

async function installPageErrorProbe(page: Page) {
  await page.addInitScript(() => {
    const win = window as typeof window & {
      __opencode_session_page_errors?: CapturedPageError[]
    }
    win.__opencode_session_page_errors = []
    const describe = (value: unknown) => {
      if (value instanceof Error) return value.stack || value.message
      if (typeof value === "string") return value
      try {
        return JSON.stringify(value)
      } catch {
        return String(value)
      }
    }
    window.addEventListener("error", (event) => {
      win.__opencode_session_page_errors?.push({
        type: "error",
        message: event.message,
        detail: describe(event.error),
      })
    })
    window.addEventListener("unhandledrejection", (event) => {
      win.__opencode_session_page_errors?.push({
        type: "unhandledrejection",
        message: describe(event.reason),
      })
    })
  })
}

async function readPageErrorProbe(page: Page) {
  return page.evaluate(() => {
    const win = window as typeof window & {
      __opencode_session_page_errors?: CapturedPageError[]
    }
    return win.__opencode_session_page_errors ?? []
  }) as Promise<CapturedPageError[]>
}

function collectPageErrors(page: Page) {
  const errors: CapturedPageError[] = []
  const describe = (value: unknown) => {
    if (value instanceof Error) return value.stack || value.message
    if (typeof value === "string") return value
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  const handler = (error: Error) => {
    errors.push({ type: "pageerror", message: describe(error) })
  }
  page.on("pageerror", handler)
  return {
    errors,
    dispose: () => page.off("pageerror", handler),
  }
}

function relevantPageErrors(errors: CapturedPageError[]) {
  return errors.filter((error) => error.message !== "ResizeObserver loop completed with undelivered notifications.")
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

async function installSessionTransitionProbe(page: Page, messageOwners: Record<string, string>) {
  await page.evaluate(
    ({
      composerDockSelector,
      maxSamples,
      messageOwners,
      messageSelector,
      scrollViewportSelector,
      turnListSelector,
    }) => {
      const routeSessionID = () => window.location.pathname.match(/\/session\/([^/?#]+)/)?.[1]
      const removedMatches = (node: Node, selector: string) =>
        node instanceof Element && (node.matches(selector) || !!node.querySelector(selector))
      const sameList = (a: string[], b: string[]) =>
        a.length === b.length && a.every((item, index) => item === b[index])
      const read = (removed?: { composerDock?: boolean; messageList?: boolean }) => {
        const list = document.querySelector(turnListSelector)
        const viewport = list?.closest(scrollViewportSelector)
        const timeline = viewport instanceof HTMLElement ? viewport : undefined
        const composer = document.querySelector(composerDockSelector)
        const ownerList = Array.from(document.querySelectorAll(messageSelector))
          .map((item) => (item instanceof HTMLElement ? item.dataset.messageId : undefined))
          .filter((id): id is string => !!id)
          .map((id) => messageOwners[id] ?? "unknown")

        return {
          at: performance.now(),
          url: window.location.href,
          routeSessionID: routeSessionID(),
          messageOwners: Array.from(new Set(ownerList)),
          messages: ownerList.length,
          composerDock: document.querySelectorAll(composerDockSelector).length,
          composerHeight: composer instanceof HTMLElement ? composer.getBoundingClientRect().height : 0,
          messageList: document.querySelectorAll(turnListSelector).length,
          removedComposerDock: removed?.composerDock ?? false,
          removedMessageList: removed?.messageList ?? false,
          top: timeline?.scrollTop ?? 0,
          height: timeline?.scrollHeight ?? 0,
          client: timeline?.clientHeight ?? 0,
          distanceFromBottom: timeline ? timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop : 0,
        }
      }
      const changed = (a: ReturnType<typeof read>, b: ReturnType<typeof read>) =>
        a.url !== b.url ||
        a.routeSessionID !== b.routeSessionID ||
        a.messages !== b.messages ||
        a.composerDock !== b.composerDock ||
        a.composerHeight !== b.composerHeight ||
        a.messageList !== b.messageList ||
        a.removedComposerDock !== b.removedComposerDock ||
        a.removedMessageList !== b.removedMessageList ||
        a.top !== b.top ||
        a.height !== b.height ||
        a.client !== b.client ||
        a.distanceFromBottom !== b.distanceFromBottom ||
        !sameList(a.messageOwners, b.messageOwners)
      const samples = [read()]
      const push = () => {
        const next = read()
        const prev = samples[samples.length - 1]
        if (prev && !changed(prev, next)) return
        if (samples.length < maxSamples) samples.push(next)
      }
      const pushRemoved = (removed: { composerDock?: boolean; messageList?: boolean }) => {
        const next = read(removed)
        if (samples.length < maxSamples) samples.push(next)
      }
      let frame = requestAnimationFrame(function tick() {
        push()
        frame = requestAnimationFrame(tick)
      })
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.removedNodes) {
            const composerDock = removedMatches(node, composerDockSelector)
            const messageList = removedMatches(node, turnListSelector)
            if (composerDock || messageList) pushRemoved({ composerDock, messageList })
          }
        }
        push()
      })
      observer.observe(document.body, { childList: true, subtree: true })
      const win = window as typeof window & {
        __opencode_e2e?: Record<string, unknown> & {
          sessionTransitionProbe?: { stop: () => unknown }
        }
      }
      win.__opencode_e2e = {
        ...win.__opencode_e2e,
        sessionTransitionProbe: {
          stop() {
            cancelAnimationFrame(frame)
            observer.disconnect()
            push()
            delete win.__opencode_e2e?.sessionTransitionProbe
            return samples
          },
        },
      }
    },
    {
      composerDockSelector: sessionComposerDockSelector,
      maxSamples: 512,
      messageOwners,
      messageSelector: sessionMessageItemSelector,
      scrollViewportSelector,
      turnListSelector: sessionTurnListSelector,
    },
  )
}

async function stopSessionTransitionProbe(page: Page) {
  return page.evaluate(() => {
    const win = window as typeof window & {
      __opencode_e2e?: {
        sessionTransitionProbe?: { stop: () => unknown }
      }
    }
    const probe = win.__opencode_e2e?.sessionTransitionProbe
    if (!probe) throw new Error("session transition probe was not installed")
    return probe.stop()
  }) as Promise<SessionTransitionSample[]>
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

    const ids = await page
      .locator(sessionMessageItemSelector)
      .evaluateAll((items) =>
        items.map((item) => (item instanceof HTMLElement ? item.dataset.messageId : undefined)).filter(Boolean),
      )
    const oldID = ids[2]
    if (!oldID) throw new Error("expected an older rendered message id")

    await page.goto(`${page.url()}#message-${oldID}`)
    await expect(page.locator(`#message-${oldID}`)).toBeVisible()
    await expect.poll(async () => (await expectTimelineMetrics(page)).distanceFromBottom).toBeGreaterThan(100)

    const token = `scroll_latest_${Date.now()}`
    await sendVisiblePrompt({ page, text: `reply with ${token}` })
    await expect(page.locator(sessionMessageItemSelector).last()).toContainText(token, { timeout: 30_000 })

    await expect.poll(() => page.url()).not.toContain("#message-")
    await expect
      .poll(async () => (await expectTimelineMetrics(page)).distanceFromBottom, { timeout: 30_000 })
      .toBeLessThan(40)
    const rendered = await page
      .locator(sessionMessageItemSelector)
      .evaluateAll((items) =>
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

    const ids = await page
      .locator(sessionMessageItemSelector)
      .evaluateAll((items) =>
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
      (sample) => sample.height > sample.client + 100 && sample.top < 20 && sample.distanceFromBottom > 100,
    )
    expect(topJumps).toEqual([])
  })
})

test("does not jump to the top after mod-enter submit from an old message hash", async ({ page, project }) => {
  test.setTimeout(120_000)

  await project.open()
  const sdk = project.sdk

  await withSession(sdk, `e2e old hash mod enter ${Date.now()}`, async (session) => {
    project.trackSession(session.id)
    await seedSessionTurns({ sdk, sessionID: session.id, count: 18 })

    await project.gotoSession(session.id)
    await expect(page.locator(sessionMessageItemSelector)).toHaveCount(INITIAL_SESSION_WINDOW_MESSAGES, {
      timeout: 30_000,
    })
    await scrollTimelineToBottom(page)
    await expect.poll(async () => (await expectTimelineMetrics(page)).distanceFromBottom).toBeLessThan(20)

    const ids = await page
      .locator(sessionMessageItemSelector)
      .evaluateAll((items) =>
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
      await sendVisiblePrompt({ page, text: `mod enter top guard ${Date.now()}`, submitKey: `${modKey}+Enter` })
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
      (sample) => sample.height > sample.client + 100 && sample.top < 20 && sample.distanceFromBottom > 100,
    )
    expect(topJumps).toEqual([])
  })
})

test("renders the full initial session window when switching sessions", async ({ page, project }) => {
  test.setTimeout(120_000)

  await installPageErrorProbe(page)
  const pageErrorEvents = collectPageErrors(page)
  await project.open()
  const sdk = project.sdk

  await withSession(sdk, `e2e switch source ${Date.now()}`, async (first) => {
    project.trackSession(first.id)
    await seedSessionTurns({ sdk, sessionID: first.id, count: 14 })

    await project.gotoSession(first.id)
    await expect(page.locator(sessionMessageItemSelector)).toHaveCount(INITIAL_SESSION_WINDOW_MESSAGES, {
      timeout: 30_000,
    })

    await withSession(sdk, `e2e switch target ${Date.now()}`, async (second) => {
      project.trackSession(second.id)
      await seedSessionTurns({ sdk, sessionID: second.id, count: 14 })
      await openSidebar(page)
      const targetSession = page.locator(`${sessionItemSelector(second.id)} a`).first()
      await expect(targetSession).toBeVisible({ timeout: 30_000 })

      const firstMessages = await sdk.session.messages({ sessionID: first.id, limit: 100 }).then((r) => r.data ?? [])
      const secondMessages = await sdk.session.messages({ sessionID: second.id, limit: 100 }).then((r) => r.data ?? [])
      const messageOwners = Object.fromEntries([
        ...firstMessages.map((item) => [item.info.id, first.id] as const),
        ...secondMessages.map((item) => [item.info.id, second.id] as const),
      ])

      await installSessionTransitionProbe(page, messageOwners)
      await targetSession.click()
      await expect.poll(() => new URL(page.url()).pathname.endsWith(`/session/${second.id}`)).toBe(true)
      await expect(page.locator(sessionMessageItemSelector)).toHaveCount(INITIAL_SESSION_WINDOW_MESSAGES, {
        timeout: 30_000,
      })
      const samples = await stopSessionTransitionProbe(page)
      const rendered = await page
        .locator(sessionMessageItemSelector)
        .evaluateAll((items) =>
          items.map((item) => (item instanceof HTMLElement ? item.dataset.messageId : undefined)).filter(Boolean),
        )
      const secondIDs = new Set(secondMessages.map((item) => item.info.id))

      const switched = samples.filter((sample) => sample.routeSessionID === second.id)
      const mixedOwnerFrames = switched.filter(
        (sample) => sample.messageOwners.length > 1 || sample.messageOwners.includes("unknown"),
      )
      const removedMountFrames = samples.filter((sample) => sample.removedComposerDock || sample.removedMessageList)
      const invalidComposerFrames = switched.filter((sample) => sample.composerDock !== 1 || sample.composerHeight <= 0)
      const invalidMessageListFrames = switched.filter((sample) => sample.messageList !== 1)
      const pageErrors = relevantPageErrors(await readPageErrorProbe(page))

      expect(switched.length).toBeGreaterThan(0)
      expect(rendered.every((id) => secondIDs.has(id))).toBe(true)
      expect(switched.filter((sample) => sample.messages === 0)).toEqual([])
      expect(
        switched.filter((sample) => sample.messages > 0 && sample.messages < INITIAL_SESSION_WINDOW_MESSAGES),
      ).toEqual([])
      expect(mixedOwnerFrames).toEqual([])
      expect(removedMountFrames).toEqual([])
      expect(invalidComposerFrames).toEqual([])
      expect(invalidMessageListFrames).toEqual([])
      expect(pageErrors).toEqual([])

      const current = new URL(page.url())
      current.hash = ""
      current.search = ""
      current.pathname = current.pathname.replace(/\/session\/[^/]+$/, "/session")
      await page.goto(current.toString())
    })
  })
  expect(relevantPageErrors(pageErrorEvents.errors)).toEqual([])
  pageErrorEvents.dispose()
})
