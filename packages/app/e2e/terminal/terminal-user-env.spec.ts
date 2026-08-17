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

  // The restore instruction carries the host's pre-existing XDG values, so
  // the terminal renders whatever the host had ("unset" when clean, the path
  // otherwise). Derive the expected marker from the same host env the harness
  // used, so the spec is host-deterministic. The real leak check is below:
  // a sandbox path in the rendered output means the namespace leaked.
  const expectedXdg = process.env.XDG_CONFIG_HOME ?? "unset"
  const cmd = "echo XDG_MARKER_${XDG_CONFIG_HOME:-unset} RESTORE_MARKER_${PAWWORK_USER_ENV_RESTORE:-unset}"
  await runTerminal(page, { term, cmd, token: `XDG_MARKER_${expectedXdg} RESTORE_MARKER_unset` })

  const rendered = await term.textContent()
  expect(rendered).not.toContain("opencode-e2e-")
})
