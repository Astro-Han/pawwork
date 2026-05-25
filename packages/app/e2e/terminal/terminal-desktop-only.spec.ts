import { test, expect } from "../fixtures"
import { openPalette } from "../actions"
import { terminalSelector } from "../selectors"
import { terminalToggleKey } from "../utils"

// Post-flatten (Area B 2026-05-25) the terminal surface lives entirely in the
// desktop-only right panel: the flatten removed the standalone non-desktop
// `<TerminalPanel />` host that used to render at <768px. So terminal.toggle /
// terminal.new and their keybinds are gated behind isDesktop. On narrow
// layouts they must not be registered at all — otherwise the keybind flips
// legacy view().terminal state with nothing to render (the regression this
// guards against).

const terminalToggleItem = '[data-slot="list-item"][data-key="command:terminal.toggle"]'
const terminalNewItem = '[data-slot="list-item"][data-key="command:terminal.new"]'

test("terminal commands and keybinds are absent on narrow (non-desktop) layouts", async ({
  page,
  gotoSession,
}) => {
  // Resize below the 768px desktop breakpoint before loading the session so
  // the layout settles as non-desktop.
  await page.setViewportSize({ width: 600, height: 900 })
  await gotoSession()

  // The keybinds must be no-ops: nothing terminal-shaped renders.
  await page.keyboard.press(terminalToggleKey)
  await page.keyboard.press("Control+Alt+T")
  await expect(page.locator(terminalSelector)).toHaveCount(0)

  // And neither command is reachable from the palette.
  const dialog = await openPalette(page)
  await dialog.getByRole("textbox").fill("terminal")
  await expect(dialog.locator(terminalToggleItem)).toHaveCount(0)
  await expect(dialog.locator(terminalNewItem)).toHaveCount(0)
})

test("terminal commands are registered on desktop layouts", async ({ page, gotoSession }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await gotoSession()

  const dialog = await openPalette(page)
  await dialog.getByRole("textbox").fill("terminal")
  await expect(dialog.locator(terminalToggleItem)).toHaveCount(1)
  await expect(dialog.locator(terminalNewItem)).toHaveCount(1)
})
