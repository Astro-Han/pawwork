import { test, expect } from "../fixtures"
import { runPromptSlash, waitTerminalFocusIdle } from "../actions"
import { promptSelector, terminalSelector } from "../selectors"

test("/terminal opens the right-panel terminal tab", async ({ page, gotoSession }) => {
  await gotoSession()

  const prompt = page.locator(promptSelector)
  const terminal = page.locator(terminalSelector)
  const rightPanel = page.locator("#right-panel")
  const shellTabList = rightPanel.getByRole("tablist").first()
  const terminalTab = shellTabList.getByRole("tab", { name: "Terminal", exact: true })
  const embeddedTerminalTabs = page.locator('#terminal-panel [data-slot="tabs-trigger"]')

  await expect(terminal).not.toBeVisible()
  await expect(rightPanel).toHaveAttribute("aria-hidden", "true")
  await expect(embeddedTerminalTabs).toHaveCount(0)

  await runPromptSlash(page, { prompt, text: "/terminal", id: "terminal.toggle" })
  await waitTerminalFocusIdle(page, { term: terminal })
  await expect(rightPanel).toHaveAttribute("aria-hidden", "false")
  await expect(terminalTab).toHaveAttribute("aria-selected", "true")
  await expect(page.locator("#terminal-panel")).toBeVisible()
  await expect(embeddedTerminalTabs).toHaveCount(1)
})
