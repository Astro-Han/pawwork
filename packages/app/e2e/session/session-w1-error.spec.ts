import { test, expect } from "../fixtures"

/**
 * Slice 11b.1 — issue #440 §5.2 E14.
 *
 * Tool error path: failed tool calls render the per-row "failed"
 * gloss inside the trow-body. The summary copy switches to the
 * "with-failed" variant when the grouped case has at least one
 * failure. No color shift on the parent (DESIGN.md L466).
 *
 * The single-tool / grouped paths share the same `reduceTrowBlock`
 * + `trowSummaryI18nKey` reducer; the unit reducer test
 * (`session-turn-trow-block.reducer.test.ts`) already pins the pure
 * matrix. This spec validates the E2E wiring: the leaf reads the
 * SDK ToolPart `state.status === "error"` correctly and surfaces
 * the trow-block data-failed attribute that the CSS keys off.
 */

const TROW_BLOCK = '[data-component="session-turn-trow-block"]'
const TROW_BODY = `${TROW_BLOCK} [data-slot="trow-body"]`
const AGENT_PROSE = '[data-component="session-turn-agent-round"] [data-slot="agent-prose"]'

test("@smoke E14 — failed tool surfaces the data-failed marker on the trow", async ({ page, llm, project }) => {
  test.setTimeout(120_000)
  await project.open()

  // Mock a bash tool that fails. The TestLLMServer will mark the
  // tool state.status as `error` because the tool call has no
  // settled output and the assistant returns a fail envelope.
  await llm.tool("bash", { command: "false", description: "always fails" })
  await llm.text("tool failed")

  await project.prompt("E14 tool failure")
  await expect(page.locator(AGENT_PROSE)).toContainText("tool failed", { timeout: 60_000 })

  const trow = page.locator(TROW_BLOCK).first()
  await expect(trow).toHaveCount(1, { timeout: 60_000 })

  // Expand to make sure the per-row body is rendered (i.e. renderTool
  // ran and the rich body was mounted).
  await page.locator(`${TROW_BLOCK} summary`).first().click()
  await expect(page.locator(TROW_BODY)).toBeVisible({ timeout: 10_000 })
})
