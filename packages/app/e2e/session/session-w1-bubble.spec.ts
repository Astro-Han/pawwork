import { test, expect } from "../fixtures"

/**
 * Slice 11b.1 — issue #440 §5.2 E1 + E9 + E10.
 *
 * Smoke E2E for the W1 user-bubble + agent-round surfaces now that
 * `session-turn.tsx` mounts the W1 leaves on the default user path
 * (Phase 2b integration commit).
 *
 * The verifications are structural / behavioral — visual rhythm,
 * shimmer cadence, and reduce-motion are covered by the dev:desktop
 * checklist (D-items) and by the unit tests on the leaves themselves.
 */

const USER_BUBBLE = '[data-component="session-turn-user-bubble"]'
const BUBBLE_TEXT = `${USER_BUBBLE} [data-slot="bubble-text"]`
const BUBBLE_COPY = `${USER_BUBBLE} [data-action="copy"]`
const BUBBLE_RESET = `${USER_BUBBLE} [data-action="reset"]`

const AGENT_ROUND = '[data-component="session-turn-agent-round"]'
const AGENT_WORKING_TIME = `${AGENT_ROUND} [data-slot="agent-working-time"]`
const AGENT_PROSE = `${AGENT_ROUND} [data-slot="agent-prose"]`
const AGENT_COPY = `${AGENT_ROUND} [data-action="copy"]`
const AGENT_FORK = `${AGENT_ROUND} [data-action="fork"]`

test("@smoke E1 — user message + agent stream mounts W1 leaves on the default path", async ({ page, llm, project }) => {
  test.setTimeout(120_000)
  await project.open()

  const reply = "W1 agent reply text"
  await llm.text(reply)
  await project.prompt("E1 verify W1 surface")

  // User bubble is the W1 leaf, not the legacy `<UserMessageDisplay>`.
  await expect(page.locator(USER_BUBBLE)).toHaveCount(1, { timeout: 30_000 })
  await expect(page.locator(BUBBLE_TEXT)).toContainText("E1 verify W1 surface")

  // Agent round is the W1 leaf, agent-toolbar is mounted (visibility
  // is CSS-only; the DOM presence + aria-hidden gate is the testable
  // surface here).
  await expect(page.locator(AGENT_ROUND)).toHaveCount(1, { timeout: 30_000 })
  await expect(page.locator(AGENT_PROSE)).toContainText(reply, { timeout: 30_000 })

  // Working-time tick exists once the round has started; the freeze
  // value after the round completes is whatever the assistant message
  // `time.completed - time.created` resolved to.
  await expect(page.locator(AGENT_WORKING_TIME)).toHaveCount(1, { timeout: 30_000 })
  const tick = await page.locator(AGENT_WORKING_TIME).textContent()
  expect(tick).toMatch(/\d+s/)
})

test("@smoke E9 — bubble [Copy] writes the user text to the clipboard", async ({ page, llm, project, browserName }) => {
  test.setTimeout(120_000)
  // Clipboard API is gated to the active document and requires the
  // Playwright permission grant before navigation in chromium.
  test.skip(browserName !== "chromium", "navigator.clipboard.writeText only granted in chromium fixture")
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"])

  await project.open()
  await llm.text("agent ack")
  await project.prompt("E9 copy this user text")
  await expect(page.locator(USER_BUBBLE)).toHaveCount(1, { timeout: 30_000 })

  await page.locator(BUBBLE_COPY).click()
  await expect(page.locator(`${BUBBLE_COPY}[data-copied]`)).toHaveCount(1, { timeout: 5_000 })

  const value = await page.evaluate(() => navigator.clipboard.readText())
  expect(value).toContain("E9 copy this user text")
})

test("@smoke E10 — agent toolbar [Copy] writes the concatenated prose to the clipboard", async ({
  page,
  llm,
  project,
  browserName,
}) => {
  test.setTimeout(120_000)
  test.skip(browserName !== "chromium", "navigator.clipboard.writeText only granted in chromium fixture")
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"])

  const prose = "Agent prose paragraph one\n\nparagraph two"

  await project.open()
  await llm.text(prose)
  await project.prompt("E10 user kickoff")
  await expect(page.locator(AGENT_PROSE)).toContainText("paragraph two", { timeout: 30_000 })

  // The agent-toolbar copy button stays visibility-hidden while the
  // round is running. Wait for the streaming agent message to fully
  // settle by polling the SDK before asserting the copy fires.
  const sessionID = await page.evaluate(() => {
    const url = new URL(window.location.href)
    return url.pathname.split("/session/")[1] ?? ""
  })
  if (!sessionID) throw new Error("expected a session id in the URL")
  await expect
    .poll(
      async () =>
        await project.sdk.session
          .messages({ sessionID, limit: 50 })
          .then((r) => (r.data ?? []).filter((m) => m.info.role === "assistant" && m.info.time.completed !== undefined).length),
      { timeout: 30_000, intervals: [200, 500, 1_000] },
    )
    .toBeGreaterThan(0)

  // Force the toolbar visible via hover so the click lands. The leaf
  // keeps `pointer-events:none` while running.
  await page.locator(AGENT_ROUND).hover()
  await page.locator(AGENT_COPY).click()
  await expect(page.locator(`${AGENT_COPY}[data-copied]`)).toHaveCount(1, { timeout: 5_000 })

  const value = await page.evaluate(() => navigator.clipboard.readText())
  expect(value).toContain("Agent prose paragraph one")
})

test("@smoke E7 — bubble [Reset] adopts the legacy revert path (revertDock, no dialog)", async ({
  page,
  llm,
  project,
}) => {
  test.setTimeout(120_000)
  await project.open()

  await llm.text("agent ack")
  await project.prompt("E7 reset target")
  await expect(page.locator(USER_BUBBLE)).toHaveCount(1, { timeout: 30_000 })
  await expect(page.locator(AGENT_PROSE)).toContainText("agent ack", { timeout: 30_000 })

  await page.locator(USER_BUBBLE).hover()
  await page.locator(BUBBLE_RESET).click()

  // The W1 [Reset] mounts the existing revert dock above the composer.
  // The bubble for the resetted message is removed from the timeline.
  await expect(page.locator(BUBBLE_TEXT)).toHaveCount(0, { timeout: 30_000 })
})

test("@smoke E8 — agent toolbar [Fork] is mounted next to [Copy] for the W1 surface", async ({
  page,
  llm,
  project,
}) => {
  test.setTimeout(120_000)
  await project.open()

  await llm.text("ack pre-fork")
  await project.prompt("E8 fork source")
  await expect(page.locator(AGENT_ROUND)).toHaveCount(1, { timeout: 30_000 })
  await expect(page.locator(AGENT_PROSE)).toContainText("ack pre-fork", { timeout: 30_000 })

  // Fork stays mounted in the DOM (visibility is CSS) so a presence
  // assertion is enough — the navigation behaviour is covered by
  // session-w1-fork.spec when the host wires sdk.session.fork.
  await page.locator(AGENT_ROUND).hover()
  await expect(page.locator(AGENT_FORK)).toHaveCount(1)
})
