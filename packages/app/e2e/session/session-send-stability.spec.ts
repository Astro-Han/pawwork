import type { Page } from "@playwright/test"
import { test, expect } from "../fixtures"
import { assistantText } from "../actions"
import {
  promptSelector,
  sessionComposerDockSelector,
  sessionMessageItemSelector,
  sessionTurnListSelector,
} from "../selectors"

const MAX_STABILITY_SAMPLES = 256

type StabilitySample = {
  at: number
  url: string
  composerDock: number
  messageList: number
  messages: number
}
type StabilityProbeResult = {
  samples: StabilitySample[]
  unmounts: StabilitySample[]
  unmountCount: number
}

async function installSessionStabilityProbe(page: Page) {
  await page.evaluate(
    ({ composerDockSelector, maxSamples, messageItemSelector, turnListSelector }) => {
      const read = () => ({
        at: performance.now(),
        url: window.location.href,
        composerDock: document.querySelectorAll(composerDockSelector).length,
        messageList: document.querySelectorAll(turnListSelector).length,
        messages: document.querySelectorAll(messageItemSelector).length,
      })
      const changed = (a: ReturnType<typeof read>, b: ReturnType<typeof read>) =>
        a.url !== b.url ||
        a.composerDock !== b.composerDock ||
        a.messageList !== b.messageList ||
        a.messages !== b.messages
      const samples = [read()]
      const unmounts: ReturnType<typeof read>[] = []
      let unmountCount = 0
      const pushBounded = (list: ReturnType<typeof read>[], sample: ReturnType<typeof read>) => {
        if (list.length < maxSamples) list.push(sample)
      }
      const record = () => {
        const next = read()
        const prev = samples[samples.length - 1]
        if (!prev || changed(prev, next)) pushBounded(samples, next)
      }
      const removedMatches = (node: Node, selector: string) =>
        node instanceof Element && (node.matches(selector) || !!node.querySelector(selector))
      const recordRemovedMount = (input: { composerDock: boolean; messageList: boolean }) => {
        unmountCount += 1
        const current = read()
        const sample = {
          ...current,
          composerDock: input.composerDock ? 0 : current.composerDock,
          messageList: input.messageList ? 0 : current.messageList,
        }
        pushBounded(samples, sample)
        pushBounded(unmounts, sample)
      }
      const recordMutations = (records: MutationRecord[]) => {
        for (const record of records) {
          for (const node of record.removedNodes) {
            const composerDockRemoved = removedMatches(node, composerDockSelector)
            const messageListRemoved = removedMatches(node, turnListSelector)
            if (composerDockRemoved || messageListRemoved) {
              recordRemovedMount({ composerDock: composerDockRemoved, messageList: messageListRemoved })
            }
          }
        }
        record()
      }
      let frame = requestAnimationFrame(function tick() {
        record()
        frame = requestAnimationFrame(tick)
      })
      const observer = new MutationObserver(recordMutations)
      observer.observe(document.body, { childList: true, subtree: true })
      const win = window as typeof window & {
        __opencode_e2e?: Record<string, unknown> & {
          sessionMountProbe?: { stop: () => unknown }
        }
      }
      win.__opencode_e2e = {
        ...win.__opencode_e2e,
        sessionMountProbe: {
          stop() {
            cancelAnimationFrame(frame)
            observer.disconnect()
            record()
            delete win.__opencode_e2e?.sessionMountProbe
            return { samples, unmounts, unmountCount }
          },
        },
      }
    },
    {
      composerDockSelector: sessionComposerDockSelector,
      maxSamples: MAX_STABILITY_SAMPLES,
      messageItemSelector: sessionMessageItemSelector,
      turnListSelector: sessionTurnListSelector,
    },
  )
}

async function stopSessionStabilityProbe(page: Page) {
  const result = await page.evaluate(() => {
    const win = window as typeof window & {
      __opencode_e2e?: {
        sessionMountProbe?: { stop: () => unknown }
      }
    }
    const probe = win.__opencode_e2e?.sessionMountProbe
    if (!probe) throw new Error("session stability probe was not installed")
    return probe.stop()
  })
  return result as StabilityProbeResult
}

test("keeps the session flow mounted while sending a prompt", async ({ page, project, assistant }) => {
  test.setTimeout(120_000)

  await project.open()
  await assistant.reply("seed reply")
  const sessionID = await project.prompt("start a session")

  await expect(page.locator(sessionTurnListSelector)).toHaveCount(1)
  await expect(page.locator(sessionComposerDockSelector)).toHaveCount(1)

  const beforeCalls = await assistant.calls()
  const token = `I248_OK_${Date.now()}`
  await assistant.reply(token)

  await installSessionStabilityProbe(page)
  let result: StabilityProbeResult = { samples: [], unmounts: [], unmountCount: 0 }
  try {
    const prompt = page.locator(promptSelector).first()
    await expect(prompt).toBeVisible()
    await prompt.click()
    await page.keyboard.type(`reply with ${token}`)
    await expect
      .poll(async () => (await prompt.textContent())?.replace(/\u200B/g, "").trim())
      .toBe(`reply with ${token}`)
    await page.keyboard.press("Enter")

    await expect.poll(() => assistant.calls(), { timeout: 30_000 }).toBeGreaterThan(beforeCalls)
    await expect.poll(() => assistantText(project.sdk, sessionID), { timeout: 30_000 }).toContain(token)
  } finally {
    result = await stopSessionStabilityProbe(page)
  }

  const unmounted = result.samples.filter((sample) => sample.composerDock === 0 || sample.messageList === 0)
  expect(unmounted).toEqual([])
  expect(result.unmounts).toEqual([])
  expect(result.unmountCount).toBe(0)
  expect(new Set(result.samples.map((sample) => sample.url)).size).toBe(1)
})
