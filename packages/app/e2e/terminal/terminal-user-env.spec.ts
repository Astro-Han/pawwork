import { runTerminal, waitTerminalReady } from "../actions"
import { test, expect } from "../fixtures"
import { terminalSelector } from "../selectors"
import { terminalToggleKey } from "../utils"

// The backend sandbox namespaces its own XDG dirs and publishes the PawWork
// restore instruction, exactly like the desktop app. A terminal is a user
// shell: XDG-following CLIs (crush in #1528) must see the user's config home,
// and the instruction itself must never reach the child.
test("a terminal shows the user's XDG env, not the app's sandbox namespace", async ({ page, project }) => {
  await project.open()

  const term = page.locator(terminalSelector).first()
  if (!(await term.isVisible().catch(() => false))) await page.keyboard.press(terminalToggleKey)
  await waitTerminalReady(page, { term })

  // On a clean host runner every XDG key is unset: the markers must render
  // their "unset" fallback. If the sandbox leaked, the marker would carry the
  // sandbox path instead and the token would never appear.
  const cmd = "echo XDG_MARKER_${XDG_CONFIG_HOME:-unset} RESTORE_MARKER_${PAWWORK_USER_ENV_RESTORE:-unset}"
  await runTerminal(page, { term, cmd, token: "XDG_MARKER_unset RESTORE_MARKER_unset" })

  const rendered = await term.textContent()
  expect(rendered).not.toContain("opencode-e2e-")
})
