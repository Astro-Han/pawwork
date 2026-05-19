import type { Page } from "@playwright/test"
import { test, expect } from "../fixtures"
import { withSession } from "../actions"
import { promptSelector, questionDockSelector, sessionMessageItemSelector, sessionTurnListSelector } from "../selectors"
import {
  hasPrimaryRuntimeClsShift,
  installRuntimeClsProbe,
  startRuntimeClsProbe,
  stopRuntimeClsProbe,
} from "./runtime-cls-probe"

type Sdk = Parameters<typeof withSession>[0]

const longTurnText = (label: string, lines = 120) =>
  [
    `${label}:`,
    "",
    "```ts",
    ...Array.from({ length: lines }, (_, index) => `const ${label.replaceAll("-", "_")}_${index} = ${index}`),
    "```",
    "",
    ...Array.from({ length: 8 }, (_, index) => `markdown paragraph ${index} ${"content ".repeat(12)}`),
  ].join("\n")

async function seedSessionTurns(input: { sdk: Sdk; sessionID: string; count: number }) {
  for (let index = 0; index < input.count; index++) {
    await input.sdk.session.promptAsync({
      sessionID: input.sessionID,
      noReply: true,
      parts: [{ type: "text", text: longTurnText(`runtime-cls-seed-${index}`) }],
    })
  }
}

async function scrollTimelineToMiddle(page: Page) {
  await page.evaluate(() => {
    const list = document.querySelector('[data-slot="session-turn-list"]')
    const viewport = list?.closest('[data-component="scroll-viewport"]')
    if (!(viewport instanceof HTMLElement)) throw new Error("Missing scroll viewport")
    viewport.scrollTop = Math.max(0, (viewport.scrollHeight - viewport.clientHeight) / 2)
    viewport.dispatchEvent(new Event("scroll", { bubbles: true }))
  })
}

async function waitForStableFrames(page: Page, frames = 3) {
  await page.evaluate((frames) => {
    return new Promise<void>((resolve) => {
      let remaining = frames
      const tick = () => {
        remaining -= 1
        if (remaining <= 0) resolve()
        else requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  }, frames)
}

async function firstVisibleMessageID(page: Page) {
  const messageID = await page.locator(sessionMessageItemSelector).first().getAttribute("data-message-id")
  expect(messageID, "runtime CLS target message should exist").not.toBeNull()
  return messageID!
}

async function setupRuntimeClsSession(input: {
  page: Page
  sdk: Sdk
  sessionID: string
  gotoSession: (sessionID: string) => Promise<void>
}) {
  await installRuntimeClsProbe(input.page)
  await seedSessionTurns({ sdk: input.sdk, sessionID: input.sessionID, count: 12 })
  await input.gotoSession(input.sessionID)
  await expect(input.page.locator(sessionTurnListSelector)).toBeVisible()
  await expect(input.page.locator(sessionMessageItemSelector)).toHaveCount(10)
  await scrollTimelineToMiddle(input.page)
  await waitForStableFrames(input.page)
}

async function measureRuntimeClsAction(input: {
  page: Page
  action: string
  targetMessageID: string
  run: () => Promise<void>
}) {
  const targetStyle = await startRuntimeClsProbe(input.page, input.action, input.targetMessageID)
  await input.run()
  await waitForStableFrames(input.page, 4)
  const snapshot = await stopRuntimeClsProbe(input.page)

  expect(targetStyle, `${input.action} should record target lazy-layout state`).toBeDefined()
  expect(targetStyle?.messageID).toBe(input.targetMessageID)
  expect(targetStyle?.contentVisibility).not.toBe("auto")
  expect(targetStyle?.containIntrinsicSize).not.toContain("500px")
  expect(hasPrimaryRuntimeClsShift(snapshot), JSON.stringify(snapshot, null, 2)).toBe(false)
}

test("composer growth does not keep offscreen turn wrappers under lazy layout", async ({ page, sdk, gotoSession }) => {
  await withSession(sdk, `e2e runtime CLS growth ${Date.now()}`, async (session) => {
    await setupRuntimeClsSession({ page, sdk, sessionID: session.id, gotoSession })
    const targetMessageID = await firstVisibleMessageID(page)

    await measureRuntimeClsAction({
      page,
      action: "composer-growth",
      targetMessageID,
      run: async () => {
        const prompt = page.locator(promptSelector).first()
        await expect(prompt).toBeVisible()
        await prompt.click()
        await page.keyboard.insertText(
          Array.from({ length: 12 }, (_, index) => `composer growth line ${index}`).join("\n"),
        )
      },
    })
  })
})

test("composer shrink does not keep offscreen turn wrappers under lazy layout", async ({ page, sdk, gotoSession }) => {
  await withSession(sdk, `e2e runtime CLS shrink ${Date.now()}`, async (session) => {
    await setupRuntimeClsSession({ page, sdk, sessionID: session.id, gotoSession })
    const prompt = page.locator(promptSelector).first()
    await expect(prompt).toBeVisible()
    await prompt.click()
    await page.keyboard.insertText(Array.from({ length: 12 }, (_, index) => `composer shrink line ${index}`).join("\n"))
    await waitForStableFrames(page)
    const targetMessageID = await firstVisibleMessageID(page)

    await measureRuntimeClsAction({
      page,
      action: "composer-shrink",
      targetMessageID,
      run: async () => {
        await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A")
        await page.keyboard.press("Backspace")
      },
    })
  })
})

test("question dock growth does not keep offscreen turn wrappers under lazy layout", async ({ page, project }) => {
  await project.open()
  await withSession(project.sdk, `e2e runtime CLS question ${Date.now()}`, async (session) => {
    await setupRuntimeClsSession({ page, sdk: project.sdk, sessionID: session.id, gotoSession: project.gotoSession })
    const targetMessageID = await firstVisibleMessageID(page)

    await measureRuntimeClsAction({
      page,
      action: "question-dock-growth",
      targetMessageID,
      run: async () => {
        const response = await fetch(
          `${project.url}/question/__e2e/ask?directory=${encodeURIComponent(project.directory)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionID: session.id,
              questions: [
                {
                  header: "Need input",
                  question: "Pick one option from a dock that appears during the measured runtime CLS window.",
                  options: [
                    { label: "Continue", description: "Continue now" },
                    { label: "Stop", description: "Stop here" },
                  ],
                },
              ],
            }),
          },
        )
        expect(response.status, await response.text()).toBe(204)
        await expect(page.locator(questionDockSelector)).toBeVisible()
      },
    })
  })
})

test("question dock shrink does not keep offscreen turn wrappers under lazy layout", async ({ page, project }) => {
  await project.open()
  await withSession(project.sdk, `e2e runtime CLS question shrink ${Date.now()}`, async (session) => {
    await setupRuntimeClsSession({ page, sdk: project.sdk, sessionID: session.id, gotoSession: project.gotoSession })
    const response = await fetch(
      `${project.url}/question/__e2e/ask?directory=${encodeURIComponent(project.directory)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionID: session.id,
          questions: [
            {
              header: "Need input",
              question: "Pick one option before the measured runtime CLS window closes the dock.",
              options: [
                { label: "Continue", description: "Continue now" },
                { label: "Stop", description: "Stop here" },
              ],
            },
          ],
        }),
      },
    )
    expect(response.status, await response.text()).toBe(204)
    await expect(page.locator(questionDockSelector)).toBeVisible()
    await waitForStableFrames(page)
    const targetMessageID = await firstVisibleMessageID(page)

    await measureRuntimeClsAction({
      page,
      action: "question-dock-shrink",
      targetMessageID,
      run: async () => {
        const dock = page.locator(questionDockSelector)
        await dock.locator('[data-slot="question-option"]').first().click()
        await dock.getByRole("button", { name: /submit/i }).click()
        await expect(page.locator(questionDockSelector)).toHaveCount(0)
      },
    })
  })
})

test("long markdown and code turns do not keep wrappers under lazy layout", async ({ page, project, assistant }) => {
  await installRuntimeClsProbe(page)
  await project.open()
  await assistant.reply(longTurnText("runtime-cls-long-assistant", 160))
  await project.prompt("Create a long markdown and code response for runtime CLS coverage.")
  await expect(page.locator(sessionMessageItemSelector)).toHaveCount(1)
  await waitForStableFrames(page)
  const targetMessageID = await firstVisibleMessageID(page)

  await measureRuntimeClsAction({
    page,
    action: "long-assistant-markdown-code-turn",
    targetMessageID,
    run: async () => {
      const prompt = page.locator(promptSelector).first()
      await expect(prompt).toBeVisible()
      await prompt.click()
      await page.keyboard.insertText("small composer growth")
    },
  })
})
