import type { E2EWindow } from "../../src/testing/terminal"
import { openSettings, runTerminal, waitTerminalReady } from "../actions"
import { test, expect } from "../fixtures"
import { terminalSelector } from "../selectors"
import { terminalToggleKey } from "../utils"

// The session page truly unmounts behind /settings; the terminal runtime is
// hoisted above the router so the pty must survive the round-trip and keep
// streaming into the SAME terminal — not respawn a fresh shell.
test("a running terminal keeps streaming across a settings round-trip", async ({ page, project }) => {
  await project.open()

  const term = page.locator(terminalSelector).first()
  if (!(await term.isVisible().catch(() => false))) await page.keyboard.press(terminalToggleKey)
  await waitTerminalReady(page, { term })
  const ptyID = await term.getAttribute("data-pty-id")
  if (!ptyID) throw new Error("Active terminal missing data-pty-id")

  // A slow numbered stream: ~5 lines/second for 40s, far outlasting the trip.
  const token = `E2E_SURFACE_STREAM_${Date.now()}`
  await runTerminal(page, {
    term,
    cmd: `for i in $(seq 1 200); do echo ${token}_$i; sleep 0.2; done`,
    token: `${token}_1`,
  })

  const highestStreamed = () =>
    page.evaluate(
      (input) => {
        const state = (window as E2EWindow).__opencode_e2e?.terminal?.terminals?.[input.ptyID]
        const matches = state?.rendered.matchAll(new RegExp(`${input.token}_(\\d+)`, "g")) ?? []
        return Math.max(0, ...Array.from(matches, (m) => Number(m[1])))
      },
      { ptyID, token },
    )
  const before = await highestStreamed()
  expect(before).toBeGreaterThan(0)

  await openSettings(page)
  await expect(page.locator('[data-component="settings-page"]')).toBeVisible()
  // True unmount: the terminal leaves the DOM with the session page.
  await expect(page.locator(terminalSelector)).toHaveCount(0)

  await page.keyboard.press("Escape")
  await expect(page.locator('[data-component="settings-page"]')).toHaveCount(0)

  if (!(await term.isVisible().catch(() => false))) await page.keyboard.press(terminalToggleKey)
  await waitTerminalReady(page, { term })
  // Same pty handle — the route change must not have respawned the shell.
  await expect.poll(() => term.getAttribute("data-pty-id")).toBe(ptyID)
  // Output emitted while away (and after returning) lands in the buffer: the
  // stream index keeps climbing past where it stood when we left.
  await expect.poll(highestStreamed, { timeout: 15_000 }).toBeGreaterThan(before)

  // Stop the stream so the shared worker pty does not chatter for 40s.
  await term.click()
  await page.keyboard.press("Control+C")
})
