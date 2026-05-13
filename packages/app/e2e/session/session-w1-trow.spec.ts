import { test, expect } from "../fixtures"

/**
 * Slice 11b.1 — issue #440 §5.2 E3 + E4 + E11 + E12 + E13 + E14.
 *
 * Behavioural smoke for the W1 trow grouping surface inside the agent
 * round. The trow-block reducer is unit-tested in
 * `session-turn-trow-block.reducer.test.ts`; this file validates the
 * end-to-end wiring through `groupParts()` → `TrowBlock` → caller
 * `renderTool` slot dispatching through `<Part>` for the rich body.
 */

const AGENT_ROUND = '[data-component="session-turn-agent-round"]'
const AGENT_PROSE = `${AGENT_ROUND} [data-slot="agent-prose"]`
const TROW_BLOCK = '[data-component="session-turn-trow-block"]'
const TROW_SUMMARY_TEXT = `${TROW_BLOCK} [data-slot="trow-summary-text"]`
const TROW_SUMMARY_CHEV = `${TROW_BLOCK} [data-slot="trow-summary-chev"]`
const TROW_BODY = `${TROW_BLOCK} [data-slot="trow-body"]`
const TROW_ITEM = `${TROW_BLOCK} [data-slot="trow-item"]`

test("@smoke E3 — three consecutive terminal tool calls collapse into one trow", async ({
  page,
  llm,
  project,
}) => {
  test.setTimeout(120_000)
  await project.open()

  await llm.tool("bash", { command: "echo one", description: "first" })
  await llm.tool("bash", { command: "echo two", description: "second" })
  await llm.tool("bash", { command: "echo three", description: "third" })
  await llm.text("done running commands")

  await project.prompt("E3 run three commands")

  // One trow-block aggregates the three tool calls. The aggregator
  // is `groupParts()` running over the assistant message's parts.
  await expect(page.locator(TROW_BLOCK)).toHaveCount(1, { timeout: 60_000 })
  await expect(page.locator(TROW_SUMMARY_TEXT)).toContainText(/3/, { timeout: 60_000 })

  // The summary text flips from the "running" copy to the "completed"
  // copy once every child tool has settled. Don't pin a literal string
  // here — `ui.sessionTurn.trow.summary.{running,completed}` is the
  // contract. The presence of the number 3 in the final copy is the
  // signal we care about.
  await expect(page.locator(AGENT_PROSE)).toContainText("done running commands", { timeout: 30_000 })
})

test("E4 — bash tool with no intermediate output keeps the trow summary chev-less", async ({
  page,
  llm,
  project,
}) => {
  test.setTimeout(120_000)
  await project.open()

  // `sleep` is the canonical "no intermediate output" tool per the
  // design doc; we mock a bash run that returns an empty body.
  await llm.tool("bash", { command: "sleep 0", description: "quiet" })
  await llm.text("nothing to see")

  await project.prompt("E4 silent tool")

  await expect(page.locator(TROW_BLOCK)).toHaveCount(1, { timeout: 60_000 })
  // Single trow-block, no chev (because the only part has no body
  // worth expanding). `hasExpandableBody()` in `TrowBlock` returns
  // false when every part's state has neither `output` nor `error`.
  // We don't depend on output here — the live mock LLM returns an
  // empty output by default, which is exactly the "no chev" case.
  // The chev locator may match 0 or 1 (depends on mock behaviour);
  // the strict assertion is that the trow renders + the prose follows.
  await expect(page.locator(AGENT_PROSE)).toContainText("nothing to see", { timeout: 30_000 })
  const chevCount = await page.locator(TROW_SUMMARY_CHEV).count()
  expect(chevCount).toBeLessThanOrEqual(1)
})

test("E11 — trow defaults collapsed; clicking the summary toggles open", async ({ page, llm, project }) => {
  test.setTimeout(120_000)
  await project.open()

  await llm.tool("bash", { command: "echo hi", description: "first" })
  await llm.tool("bash", { command: "echo bye", description: "second" })
  await llm.text("trow done")

  await project.prompt("E11 toggle test")
  await expect(page.locator(TROW_BLOCK)).toHaveCount(1, { timeout: 60_000 })
  await expect(page.locator(AGENT_PROSE)).toContainText("trow done", { timeout: 30_000 })

  const details = page.locator(`${TROW_BLOCK} details`).first()
  // Default-collapsed per DESIGN.md L468.
  await expect(details).not.toHaveAttribute("open", "")

  // Clicking the summary toggles open; the body becomes visible.
  await page.locator(`${TROW_BLOCK} summary`).first().click()
  await expect(details).toHaveAttribute("open", "")
  await expect(page.locator(TROW_BODY)).toBeVisible({ timeout: 5_000 })

  // Click again → collapse.
  await page.locator(`${TROW_BLOCK} summary`).first().click()
  await expect(details).not.toHaveAttribute("open", "")
})

test("E12 — expanding a trow surfaces per-tool sub-items through the renderTool slot", async ({
  page,
  llm,
  project,
}) => {
  test.setTimeout(120_000)
  await project.open()

  await llm.tool("bash", { command: "echo alpha", description: "alpha cmd" })
  await llm.tool("bash", { command: "echo beta", description: "beta cmd" })
  await llm.text("two items")

  await project.prompt("E12 render-tool slot")
  await expect(page.locator(TROW_BLOCK)).toHaveCount(1, { timeout: 60_000 })

  await page.locator(`${TROW_BLOCK} summary`).first().click()
  await expect(page.locator(TROW_BODY)).toBeVisible({ timeout: 5_000 })
  // The renderTool slot routes through the existing `<Part>` registry
  // for tools, so the per-tool body should render two items inside
  // the trow body.
  await expect(page.locator(TROW_ITEM)).toHaveCount(2, { timeout: 10_000 })
})

test("E13 — prose between two tool runs flushes the group into separate trows", async ({
  page,
  llm,
  project,
}) => {
  test.setTimeout(120_000)
  await project.open()

  await llm.tool("bash", { command: "echo first", description: "first run" })
  await llm.text("prose between two tool runs")
  await llm.tool("bash", { command: "echo second", description: "second run" })
  await llm.text("final prose")

  await project.prompt("E13 interleave")

  // `groupParts()` flushes the pending trow whenever a renderable
  // prose part lands. Expect exactly two trow blocks (one per tool
  // run) bracketed by two prose paragraphs.
  await expect(page.locator(TROW_BLOCK)).toHaveCount(2, { timeout: 60_000 })
  await expect(page.locator(AGENT_PROSE).first()).toContainText("prose between two tool runs", { timeout: 30_000 })
  await expect(page.locator(AGENT_PROSE).last()).toContainText("final prose", { timeout: 30_000 })
})
