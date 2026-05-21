import type { Page } from "@playwright/test"
import { test, expect } from "../fixtures"
import { seedSessionQuestion, withSession } from "../actions"
import { inputMatch } from "../prompt/mock"
import {
  promptSelector,
  questionDockSelector,
  scrollViewportSelector,
  sessionMessageItemSelector,
  sessionTurnListSelector,
} from "../selectors"
import { sessionPath } from "../utils"
import { timelineEvent, type TimelineWindow } from "../../src/testing/timeline"
import { readTimelineDomBudget } from "./timeline-dom-budget"
import {
  collectRuntimeClsFailures,
  formatRuntimeClsFailure,
  installRuntimeClsProbe,
  isRuntimeClsPrimaryEntry,
  startRuntimeClsProbe,
  stopRuntimeClsProbe,
  type RuntimeClsResult,
} from "./runtime-cls-probe"

const RUNTIME_CLS_SEED_TURNS = 60
const RUNTIME_CLS_MINIMUM_ROWS = 52
const RUNTIME_CLS_MAXIMUM_MOUNTED_MESSAGES = 48
const COMPOSER_GROWTH_TEXT = Array.from({ length: 8 }, (_, index) => `composer growth line ${index + 1}`).join("\n")

const QUESTION = [
  {
    header: "Runtime CLS check",
    question: "Pick one option to close the dock",
    options: [
      { label: "Continue", description: "Continue now" },
      { label: "Stop", description: "Stop here" },
    ],
  },
]

type RuntimeClsProject = {
  directory: string
  sdk: {
    session: {
      promptAsync(input: {
        sessionID: string
        noReply: true
        parts: Array<{ type: "text"; text: string }>
      }): Promise<unknown>
    }
  }
}

function buildRuntimeClsSeedText(turn: number) {
  const body = Array.from(
    { length: 6 + (turn % 4) },
    (_, line) => `runtime cls seed turn ${turn} line ${line}: ${"mixed content ".repeat(8)}`,
  ).join("\n")
  const mixed = [
    ["## Markdown status", "", `- turn ${turn}`, "- runtime cls gate"].join("\n"),
    ["```ts", `export const runtimeClsTurn${turn} = ${turn}`, "```"].join("\n"),
    ["```diff", `- stale runtime cls row ${turn}`, `+ stable runtime cls row ${turn}`, "```"].join("\n"),
    ["Reasoning summary", `- checked dock pressure for turn ${turn}`].join("\n"),
  ][turn % 4]
  return [`runtime cls fixture turn ${turn}`, body, mixed].join("\n\n")
}

async function settleFrames(page: Page, count = 4) {
  await page.evaluate(async (frames) => {
    for (let index = 0; index < frames; index += 1) {
      await Promise.race([
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 100)),
      ])
    }
  }, count)
}

async function seedRuntimeClsSession(project: RuntimeClsProject, sessionID: string) {
  for (let turn = 0; turn < RUNTIME_CLS_SEED_TURNS; turn += 1) {
    await project.sdk.session.promptAsync({
      sessionID,
      noReply: true,
      parts: [{ type: "text", text: buildRuntimeClsSeedText(turn) }],
    })
  }
}

async function scrollTimelineToRatio(page: Page, ratio: number) {
  const found = await page.evaluate(
    ({ ratio, scrollViewportSelector, turnListSelector }) => {
      const list = document.querySelector(turnListSelector)
      const viewport = list?.closest(scrollViewportSelector)
      if (!(viewport instanceof HTMLElement)) return false
      const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
      viewport.scrollTop = maxScrollTop * ratio
      viewport.dispatchEvent(new Event("scroll", { bubbles: true }))
      return true
    },
    { ratio, scrollViewportSelector, turnListSelector: sessionTurnListSelector },
  )
  expect(found).toBe(true)
}

async function readTimelineMetrics(page: Page) {
  const metrics = await page.evaluate(
    ({ scrollViewportSelector, turnListSelector }) => {
      const list = document.querySelector(turnListSelector)
      const viewport = list?.closest(scrollViewportSelector)
      if (!(viewport instanceof HTMLElement)) return undefined
      const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
      return {
        scrollTop: viewport.scrollTop,
        scrollHeight: viewport.scrollHeight,
        clientHeight: viewport.clientHeight,
        maxScrollTop,
        distanceFromBottom: Math.max(0, maxScrollTop - viewport.scrollTop),
      }
    },
    { scrollViewportSelector, turnListSelector: sessionTurnListSelector },
  )
  expect(metrics).toBeTruthy()
  return metrics!
}

async function moveMouseOverTimeline(page: Page) {
  const box = await page.locator(scrollViewportSelector).first().boundingBox()
  expect(box).toBeTruthy()
  if (!box) return
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(140, box.height * 0.25))
}

async function positionTimelineForMeasuredWindow(page: Page) {
  // A tiny real wheel gesture marks the timeline as user-scrolled. Without
  // that, the active question turn can briefly re-lock to bottom and the
  // measured close window becomes a bottom-follow transaction instead of the
  // controlled middle-of-history dock-height transaction this gate owns.
  await expect
    .poll(
      async () => {
        await scrollTimelineToRatio(page, 0.45)
        await moveMouseOverTimeline(page)
        await page.mouse.wheel(0, -120)
        await settleFrames(page, 2)
        return (await readTimelineMetrics(page)).distanceFromBottom
      },
      { timeout: 7_000 },
    )
    .toBeGreaterThan(300)
}

async function revealRuntimeClsRows(page: Page) {
  await test.step("wait for first runtime CLS message", async () => {
    await expect(page.locator(sessionMessageItemSelector).first()).toBeVisible({ timeout: 30_000 })
  })

  await page.evaluate((eventName) => {
    window.dispatchEvent(
      new CustomEvent(eventName, {
        detail: { action: "reveal-cached" },
      }),
    )
  }, timelineEvent)
  await settleFrames(page, 4)

  for (let attempt = 0; attempt < 24; attempt += 1) {
    const budget = await readTimelineDomBudget(page)
    if (budget.totalRows >= RUNTIME_CLS_MINIMUM_ROWS) return budget

    await test.step(`load earlier runtime CLS rows attempt ${attempt + 1}`, async () => {
      await scrollTimelineToRatio(page, 0)
      await settleFrames(page, 2)

      const loadEarlier = page.getByRole("button", { name: /Load earlier messages|加载更早的消息/i }).first()
      if (await loadEarlier.isVisible().catch(() => false)) {
        await loadEarlier.click({ timeout: 1_000 }).catch(() => undefined)
        await settleFrames(page, 4)
      }
    })
  }

  await expect
    .poll(async () => (await readTimelineDomBudget(page)).totalRows, { timeout: 1_000 })
    .toBeGreaterThanOrEqual(RUNTIME_CLS_MINIMUM_ROWS)
  return await readTimelineDomBudget(page)
}

async function centerVisibleMessageID(page: Page) {
  const target = await page.evaluate(
    ({ messageSelector, scrollViewportSelector }) => {
      const viewport = document.querySelector(scrollViewportSelector)
      const viewportRect = viewport?.getBoundingClientRect()
      if (!viewportRect) return undefined
      const center = viewportRect.top + viewportRect.height / 2
      const candidates = Array.from(document.querySelectorAll(messageSelector))
        .map((node) => {
          const rect = node.getBoundingClientRect()
          return {
            id: node.getAttribute("data-message-id") ?? undefined,
            top: rect.top,
            bottom: rect.bottom,
            distance: Math.abs(rect.top + rect.height / 2 - center),
          }
        })
        .filter((item) => item.id && item.bottom > viewportRect.top && item.top < viewportRect.bottom)
        .sort((left, right) => left.distance - right.distance)
      return candidates[0]?.id
    },
    { messageSelector: sessionMessageItemSelector, scrollViewportSelector },
  )
  expect(target).toBeTruthy()
  return target!
}

async function installTimelineRuntimeClsDriver(page: Page) {
  const apply = () => {
    const win = window as TimelineWindow
    win.__opencode_e2e = { ...win.__opencode_e2e, timeline: { enabled: true } }
  }
  await page.addInitScript(apply)
  await page.evaluate(apply)
}

async function prepareRuntimeClsWindow(page: Page, project: RuntimeClsProject, sessionID: string) {
  await installTimelineRuntimeClsDriver(page)
  await test.step("navigate to runtime CLS session", async () => {
    await page.goto(sessionPath(project.directory, sessionID))
  })
  const budget = await test.step("reveal enough timeline rows for virtualized runtime CLS coverage", async () => {
    return await revealRuntimeClsRows(page)
  })
  expect(budget.totalRows).toBeGreaterThanOrEqual(RUNTIME_CLS_MINIMUM_ROWS)
  expect(budget.hasVirtualizer).toBe(true)
  expect(budget.mountedMessages).toBeLessThanOrEqual(RUNTIME_CLS_MAXIMUM_MOUNTED_MESSAGES)

  await test.step("position viewport away from top and bottom", async () => {
    await positionTimelineForMeasuredWindow(page)
  })
  return await test.step("select center visible message target", async () => {
    return await centerVisibleMessageID(page)
  })
}

async function readPromptText(page: Page) {
  return page
    .locator(promptSelector)
    .first()
    .evaluate((element) => {
      const text = element instanceof HTMLElement ? element.innerText : element.textContent
      return (text ?? "").replace(/\u200B/g, "").trim()
    })
}

async function readPromptHeight(page: Page) {
  const box = await page.locator(promptSelector).first().boundingBox()
  expect(box).toBeTruthy()
  return box?.height ?? 0
}

async function assertNoPrimaryRuntimeClsFailures(result: RuntimeClsResult) {
  const failures = collectRuntimeClsFailures(result.entries)
  const primaryEntries = result.entries.filter(isRuntimeClsPrimaryEntry)
  expect(
    failures,
    formatRuntimeClsFailure({
      action: result.action,
      entries: primaryEntries.length > 0 ? primaryEntries : result.entries,
      snapshot: result.snapshot,
    }),
  ).toEqual([])
}

test.describe("runtime CLS probe lifecycle", () => {
  test("installs into the current document after it has already loaded", async ({ page }) => {
    await page.goto("about:blank")
    await installRuntimeClsProbe(page, { mockObserver: "ready" })

    await startRuntimeClsProbe(page, "same-document-install")
    const result = await stopRuntimeClsProbe(page)

    expect(result.action).toBe("same-document-install")
  })

  test("fails instead of silently passing when layout-shift observer cannot start", async ({ page }) => {
    await installRuntimeClsProbe(page, { mockObserver: "observe-error" })
    await page.goto("about:blank")

    let errorMessage = ""
    try {
      await startRuntimeClsProbe(page, "observer-failure-check")
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }
    expect(errorMessage).toContain("layout-shift")
  })

  test("ignores layout-shift entries after stop until the next measured window", async ({ page }) => {
    await installRuntimeClsProbe(page, { mockObserver: "ready" })
    await page.goto("about:blank")
    await page.setContent('<main><div data-message-id="msg-1">visible message</div></main>')

    await startRuntimeClsProbe(page, "first-window", { targetMessageID: "msg-1" })
    const firstStop = await page.evaluate(() => {
      const win = window as typeof window & {
        __emitRuntimeClsEntry?: (
          entry: PerformanceEntry & { value: number; sources: Array<{ node: Node | null }> },
        ) => void
        __pawwork_runtime_cls_probe?: { stop: () => RuntimeClsResult }
      }
      const source = document.querySelector('[data-message-id="msg-1"]')
      win.__emitRuntimeClsEntry?.({
        name: "layout-shift",
        entryType: "layout-shift",
        startTime: performance.now() + 1,
        duration: 0,
        toJSON: () => ({}),
        value: 0.04,
        sources: [{ node: source }],
      })
      return win.__pawwork_runtime_cls_probe?.stop()
    })
    expect(firstStop?.entries).toHaveLength(1)

    const repeatedStop = await page.evaluate(() => {
      const win = window as typeof window & {
        __emitRuntimeClsEntry?: (
          entry: PerformanceEntry & { value: number; sources: Array<{ node: Node | null }> },
        ) => void
        __pawwork_runtime_cls_probe?: { stop: () => RuntimeClsResult }
      }
      const source = document.querySelector('[data-message-id="msg-1"]')
      win.__emitRuntimeClsEntry?.({
        name: "layout-shift",
        entryType: "layout-shift",
        startTime: performance.now() + 1,
        duration: 0,
        toJSON: () => ({}),
        value: 0.04,
        sources: [{ node: source }],
      })
      return win.__pawwork_runtime_cls_probe?.stop()
    })

    expect(repeatedStop?.entries).toEqual([])
  })

  test("classifies sources through the installed browser probe", async ({ page }) => {
    await installRuntimeClsProbe(page, { mockObserver: "ready" })
    await page.goto("about:blank")
    await page.setContent(
      [
        '<main><div data-message-id="msg-1">',
        '  <section data-component="session-turn">',
        '    <div data-slot="session-turn-assistant-content"><div data-component="markdown">assistant</div></div>',
        "  </section>",
        "</div>",
        '<div data-component="session-prompt-dock"><div data-slot="question-options">option</div></div></main>',
      ].join(""),
    )

    await startRuntimeClsProbe(page, "browser-classifier-primary", { targetMessageID: "msg-1" })
    const primaryResult = await page.evaluate(() => {
      const win = window as typeof window & {
        __emitRuntimeClsEntry?: (
          entry: PerformanceEntry & { value: number; sources: Array<{ node: Node | null }> },
        ) => void
        __pawwork_runtime_cls_probe?: { stop: () => RuntimeClsResult }
      }
      win.__emitRuntimeClsEntry?.({
        name: "layout-shift",
        entryType: "layout-shift",
        startTime: performance.now() + 1,
        duration: 0,
        toJSON: () => ({}),
        value: 0.04,
        sources: [{ node: document.querySelector('[data-component="markdown"]') }],
      })
      return win.__pawwork_runtime_cls_probe?.stop()
    })
    expect(primaryResult?.entries[0]?.sources[0]?.kind).toBe("primary-turn-descendant")

    await startRuntimeClsProbe(page, "browser-classifier-dock", { targetMessageID: "msg-1" })
    const dockResult = await page.evaluate(() => {
      const win = window as typeof window & {
        __emitRuntimeClsEntry?: (
          entry: PerformanceEntry & { value: number; sources: Array<{ node: Node | null }> },
        ) => void
        __pawwork_runtime_cls_probe?: { stop: () => RuntimeClsResult }
      }
      win.__emitRuntimeClsEntry?.({
        name: "layout-shift",
        entryType: "layout-shift",
        startTime: performance.now() + 1,
        duration: 0,
        toJSON: () => ({}),
        value: 0.01,
        sources: [{ node: document.querySelector('[data-slot="question-options"]') }],
      })
      return win.__pawwork_runtime_cls_probe?.stop()
    })
    expect(dockResult?.entries[0]?.sources[0]?.kind).toBe("dock-or-scroll-recovery")
  })
})

test.describe("runtime CLS source gate", () => {
  test.setTimeout(180_000)

  test("composer growth does not move visible timeline primary sources", async ({ page, project }) => {
    await installRuntimeClsProbe(page)
    await project.open()
    await withSession(project.sdk, `runtime cls composer growth ${Date.now()}`, async (session) => {
      await seedRuntimeClsSession(project, session.id)
      const targetMessageID = await prepareRuntimeClsWindow(page, project, session.id)
      const prompt = page.locator(promptSelector).first()
      await expect(prompt).toBeVisible()
      await prompt.click()
      await prompt.fill("")
      await expect.poll(async () => readPromptText(page)).toBe("")
      const beforeHeight = await readPromptHeight(page)
      await settleFrames(page, 4)

      await startRuntimeClsProbe(page, "composer-growth", { targetMessageID })
      await prompt.fill(COMPOSER_GROWTH_TEXT)
      await expect.poll(async () => readPromptHeight(page)).toBeGreaterThan(beforeHeight + 16)
      await settleFrames(page, 6)
      const result = await stopRuntimeClsProbe(page)

      await assertNoPrimaryRuntimeClsFailures(result)
    })
  })

  test("composer shrink does not move visible timeline primary sources", async ({ page, project }) => {
    await installRuntimeClsProbe(page)
    await project.open()
    await withSession(project.sdk, `runtime cls composer shrink ${Date.now()}`, async (session) => {
      await seedRuntimeClsSession(project, session.id)
      const targetMessageID = await prepareRuntimeClsWindow(page, project, session.id)
      const prompt = page.locator(promptSelector).first()
      await expect(prompt).toBeVisible()
      await prompt.click()
      await prompt.fill(COMPOSER_GROWTH_TEXT)
      const grownHeight = await expect
        .poll(async () => readPromptHeight(page))
        .toBeGreaterThan(64)
        .then(() => readPromptHeight(page))
      await settleFrames(page, 6)

      await startRuntimeClsProbe(page, "composer-shrink", { targetMessageID })
      await prompt.fill("")
      await expect.poll(async () => readPromptHeight(page)).toBeLessThan(grownHeight - 16)
      await settleFrames(page, 6)
      const result = await stopRuntimeClsProbe(page)

      await assertNoPrimaryRuntimeClsFailures(result)
    })
  })

  test("question dock close does not move visible timeline primary sources", async ({ page, project, llm }) => {
    // #818 owns question dock open/growth. This first #814 gate keeps the
    // question path to close/shrink because the current deterministic seeding
    // flow would otherwise mix dock opening with tool-message hydration.
    await installRuntimeClsProbe(page)
    await project.open()
    await withSession(project.sdk, `runtime cls question close ${Date.now()}`, async (session) => {
      await seedRuntimeClsSession(project, session.id)
      const child = await project.sdk.session
        .create({ title: `runtime cls child question ${Date.now()}`, parentID: session.id })
        .then((response) => response.data)
      if (!child?.id) throw new Error("Child session create did not return an id")
      project.trackSession(child.id)
      const dock = page.locator(questionDockSelector)
      await test.step("seed child question dock outside the measured window", async () => {
        await llm.toolMatch(inputMatch({ questions: QUESTION }), "question", { questions: QUESTION })
        await seedSessionQuestion(project.sdk, { sessionID: child.id, questions: QUESTION })
      })
      const targetMessageID =
        await test.step("reveal a long visible parent timeline window with the dock open", async () => {
          const target = await prepareRuntimeClsWindow(page, project, session.id)
          await expect(dock).toBeVisible({ timeout: 30_000 })
          await settleFrames(page, 6)
          return target
        })

      const result = await test.step("close the child question dock under the runtime CLS probe", async () => {
        await startRuntimeClsProbe(page, "question-dock-close", { targetMessageID })
        await dock.getByRole("radio", { name: /Continue/i }).click()
        await dock.getByRole("button", { name: /submit/i }).click()
        await expect(dock).toHaveCount(0)
        await expect(page.locator(promptSelector).first()).toBeVisible()
        await settleFrames(page, 6)
        return await stopRuntimeClsProbe(page)
      })

      await assertNoPrimaryRuntimeClsFailures(result)
    })
  })
})
