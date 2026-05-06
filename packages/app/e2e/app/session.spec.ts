import { test, expect } from "../fixtures"
import {
  promptSelector,
  sessionComposerColumnSelector,
  sessionComposerDockSelector,
  sessionTimelineColumnSelector,
} from "../selectors"
import { withSession } from "../actions"

test("can open an existing session and type into the prompt", async ({ page, sdk, gotoSession }) => {
  const title = `e2e smoke ${Date.now()}`

  await withSession(sdk, title, async (session) => {
    await gotoSession(session.id)

    const prompt = page.locator(promptSelector)
    await prompt.click()
    await page.keyboard.type("hello from e2e")
    await expect(prompt).toContainText("hello from e2e")
  })
})

test("@smoke session composer matches home structure without docktray or agent control", async ({
  page,
  sdk,
  gotoSession,
}) => {
  const title = `e2e unified ${Date.now()}`

  await withSession(sdk, title, async (session) => {
    await gotoSession(session.id)

    const composer = page.locator(sessionComposerDockSelector)
    await expect(composer).toBeVisible()

    // no DockTray surface
    await expect(composer.locator('[data-dock-surface="tray"]')).toHaveCount(0)

    // no Agent selector
    await expect(page.locator('[data-component="prompt-agent-control"]')).toHaveCount(0)

    // WorkspaceChip hidden in session (breadcrumb replaces it)
    await expect(page.getByRole("button", { name: /Switch workspace|切换工作目录/i })).toHaveCount(0)

    // Model + Variant controls are inside the unified bar
    await expect(composer.locator('[data-component="prompt-model-control"]')).toBeVisible()
    await expect(composer.locator('[data-component="prompt-variant-control"]')).toBeVisible()

    // send button is the brand-orange circle
    const send = composer.locator('[data-action="prompt-submit"]')
    await expect(send).toBeVisible()
  })
})

function centerX(box: { x: number; width: number }) {
  return box.x + box.width / 2
}

test("session timeline visible content is not narrower than composer shell", async ({ page, project, assistant }) => {
  await page.setViewportSize({ width: 744, height: 900 })
  await project.open()
  await assistant.reply(
    [
      "This is a deterministic assistant response for measuring the session reading column.",
      "It needs enough text to render a full-width assistant content block instead of a tiny line.",
      "The visible conversation flow should not be narrower than the visible composer input shell.",
    ].join("\n\n"),
  )
  await project.prompt("Measure the session layout width relationship.")

  const timeline = page.locator(sessionTimelineColumnSelector)
  const composerColumn = page.locator(sessionComposerColumnSelector)
  const messageContent = page.locator('[data-slot="session-turn-assistant-content"]').last()
  const composerShell = page.locator(`${sessionComposerDockSelector} [data-dock-surface="shell"]`).first()

  await expect(timeline).toBeVisible()
  await expect(composerColumn).toBeVisible()
  await expect(messageContent).toBeVisible()
  await expect(composerShell).toBeVisible()

  const assertWidthContract = async (input?: { maxComposerColumn?: number; minTimelineComposerDelta?: number }) => {
    const timelineBox = await timeline.boundingBox()
    const composerColumnBox = await composerColumn.boundingBox()
    const messageBox = await messageContent.boundingBox()
    const composerBox = await composerShell.boundingBox()
    expect(timelineBox).not.toBeNull()
    expect(composerColumnBox).not.toBeNull()
    expect(messageBox).not.toBeNull()
    expect(composerBox).not.toBeNull()

    expect(Math.abs(centerX(timelineBox!) - centerX(composerColumnBox!))).toBeLessThanOrEqual(2)
    expect(timelineBox!.width + 1).toBeGreaterThanOrEqual(composerColumnBox!.width)
    expect(messageBox!.width + 1).toBeGreaterThanOrEqual(composerBox!.width)
    if (input?.maxComposerColumn !== undefined) {
      expect(composerColumnBox!.width).toBeLessThanOrEqual(input.maxComposerColumn)
    }
    if (input?.minTimelineComposerDelta !== undefined) {
      expect(timelineBox!.width - composerColumnBox!.width).toBeGreaterThanOrEqual(input.minTimelineComposerDelta)
    }
  }

  await assertWidthContract()

  await page.setViewportSize({ width: 893, height: 776 })
  await assertWidthContract({ maxComposerColumn: 720 })

  await page.setViewportSize({ width: 1600, height: 1000 })
  await assertWidthContract({ maxComposerColumn: 920, minTimelineComposerDelta: 80 })
})
