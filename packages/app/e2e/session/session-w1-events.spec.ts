import { test, expect } from "../fixtures"

/**
 * Slice 11b.1 — issue #440 §5.2 E2 + E5 + E15 + E16.
 *
 * Covers the secondary W1 surfaces that hang off the bubble + agent
 * round: attachment rail above the bubble (E2), interrupted system
 * event line (E5), multi-turn gap rhythm (E15), and the command
 * palette /fork backup that still ships in 11b.1 alongside the new
 * toolbar Fork (E16).
 */

const USER_BUBBLE = '[data-component="session-turn-user-bubble"]'
const BUBBLE_ATTACHMENT_ROW = `${USER_BUBBLE} [data-slot="bubble-attachment-row"]`
const BUBBLE_ATTACHMENT_CHIP = '[data-component="attachment-chip"]'
const AGENT_ROUND = '[data-component="session-turn-agent-round"]'
const AGENT_PROSE = `${AGENT_ROUND} [data-slot="agent-prose"]`
const SYSTEM_EVENT = '[data-component="session-turn-event"]'
const SYSTEM_EVENT_INTERRUPTED = `${SYSTEM_EVENT}[data-kind="interrupted"]`

test("E2 — attachment row sits above the bubble for file / image parts", async ({ page, llm, project }) => {
  test.setTimeout(120_000)
  await project.open()
  const sdk = project.sdk

  await llm.text("ack attachment")

  // Use the SDK directly to seed a user message with an attached file
  // part — the browser file picker is out of scope for an E2E smoke
  // test, the rendering contract is what we're verifying here.
  const session = await sdk.session.create({ directory: sdk.directory, title: "E2 attachment" })
  if (!session.data?.id) throw new Error("session.create failed")
  const sessionID = session.data.id
  project.trackSession(sessionID)

  await sdk.session.promptAsync({
    sessionID,
    parts: [
      { type: "text", text: "E2 with attachment" },
      {
        type: "file",
        mime: "image/png",
        filename: "tiny.png",
        url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      },
    ],
  })

  await project.gotoSession(sessionID)
  await expect(page.locator(USER_BUBBLE)).toHaveCount(1, { timeout: 30_000 })
  await expect(page.locator(BUBBLE_ATTACHMENT_ROW)).toHaveCount(1, { timeout: 30_000 })
  await expect(page.locator(BUBBLE_ATTACHMENT_CHIP).first()).toBeVisible({ timeout: 30_000 })
})

test("E5 — Ctrl+C interrupt renders the muted system-event caption", async ({ page, llm, project }) => {
  test.setTimeout(120_000)
  await project.open()

  // Queue a hung response so we can interrupt mid-stream.
  await llm.hang()

  await project.prompt("E5 interrupt me")
  await expect(page.locator(AGENT_ROUND)).toHaveCount(1, { timeout: 30_000 })

  // Hit the existing escape / interrupt keybinding. The legacy
  // interrupt divider used a `MessageDivider`; the W1 surface drops
  // that and routes the same signal through `SystemEvent` inside the
  // agent round.
  await page.keyboard.press("Escape")
  await expect(page.locator(SYSTEM_EVENT_INTERRUPTED)).toHaveCount(1, { timeout: 30_000 })
})

test("E15 — multi-turn rounds each get their own working-time + agent round", async ({
  page,
  llm,
  project,
}) => {
  test.setTimeout(180_000)
  await project.open()

  await llm.text("first round done")
  await project.prompt("E15 first turn")
  await expect(page.locator(AGENT_PROSE)).toContainText("first round done", { timeout: 60_000 })

  await llm.text("second round done")
  await project.prompt("E15 second turn")

  await expect(page.locator(USER_BUBBLE)).toHaveCount(2, { timeout: 60_000 })
  await expect(page.locator(AGENT_ROUND)).toHaveCount(2, { timeout: 60_000 })
  // Each round has its own working-time tick — locator scoped to the
  // agent-round leaf prevents bleed between rounds.
  await expect(page.locator(`${AGENT_ROUND} [data-slot="agent-working-time"]`)).toHaveCount(2)
})

test("E16 — command palette /fork backup is still mounted alongside the W1 toolbar Fork", async ({
  page,
  llm,
  project,
}) => {
  test.setTimeout(120_000)
  await project.open()

  await llm.text("pre-fork ack")
  await project.prompt("E16 dialog backup")
  await expect(page.locator(AGENT_PROSE)).toContainText("pre-fork ack", { timeout: 30_000 })

  // Open the palette and type /fork — the entry should still be
  // discoverable until the post-11b.1 retirement PR removes it.
  await page.keyboard.press("Meta+K")
  await page.keyboard.type("/fork")
  await expect(page.locator('[data-slash-id="session.fork"]').first()).toBeVisible({ timeout: 10_000 })
})
