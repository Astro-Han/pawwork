import { runTerminal, waitTerminalFocusIdle } from "../actions"
import { test } from "../fixtures"
import { terminalSelector } from "../selectors"
import { terminalToggleKey } from "../utils"

// Regression coverage for #696: a returns-value inversion in the Ghostty
// custom key handler swallowed every keystroke before it could reach the
// PTY. The compile-time defense is the typed wrapper in
// `@/utils/terminal-key-handler`; this spec keeps the full keyboard → PTY →
// render path under test so a future break in any layer surfaces here.
test("terminal forwards typed characters to the underlying PTY", async ({ page, gotoSession }) => {
  await gotoSession()

  const terminal = page.locator(terminalSelector).first()
  const visible = await terminal.isVisible().catch(() => false)
  if (!visible) await page.keyboard.press(terminalToggleKey)
  await waitTerminalFocusIdle(page, { term: terminal })

  const token = `E2E_INPUT_${Date.now()}`
  await runTerminal(page, { cmd: `echo ${token}`, token })
})
