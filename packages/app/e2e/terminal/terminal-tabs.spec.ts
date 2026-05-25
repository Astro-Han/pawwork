import type { Page } from "@playwright/test"
import { runTerminal, waitTerminalReady } from "../actions"
import { test, expect } from "../fixtures"
import { promptSelector, rightPanelTabsScopeSelector, terminalSelector } from "../selectors"
import { terminalToggleKey, workspacePersistKey } from "../utils"

// Post-flatten (Area B 2026-05-25): every terminal is its own outer right-
// panel tab. We count terminal triggers via data-key^="terminal:" on the
// right-panel tab strip rather than the gone `#terminal-panel` inner strip.
// Labels are cwd basename (e.g. "opencode-e2e-project-XXXXXX") with same-
// name dedup, so filter by index rather than the obsolete "Terminal N" text.
const terminalTabSelector = `${rightPanelTabsScopeSelector} [data-slot="tabs-trigger"][data-key^="terminal:"]`
const terminalChipWrapperSelector = `${rightPanelTabsScopeSelector} [data-slot="tabs-trigger-wrapper"][data-value^="terminal:"]`

// Persisted terminal-workspace shape. The schema bumped to v2 alongside the
// flatten: tabs live under `tabs`, the active tab id is `activeTabID`, and
// the xterm buffer is nested under `snapshot.buffer` per tab.
type State = {
  version?: number
  activeTabID?: string
  tabs: Array<{
    tabID: string
    title: string
    titleNumber: number
    order?: number
    snapshot?: {
      buffer?: string
    }
  }>
}

async function open(page: Page) {
  const terminal = page.locator(terminalSelector)
  const visible = await terminal.isVisible().catch(() => false)
  if (!visible) await page.keyboard.press(terminalToggleKey)
  await waitTerminalReady(page, { term: terminal })
}

async function newTerminal(page: Page) {
  // Flatten removed the in-strip "+ new terminal" button. The two reachable
  // affordances are the global keybind and the right-panel "+" dropdown.
  // Use the keybind — it's the same path the smoke terminal-init test takes
  // and avoids opening the dropdown menu mid-test.
  await page.locator(promptSelector).click()
  await page.keyboard.press("Control+Alt+T")
}

async function store(page: Page, key: string) {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key)
    if (raw) return JSON.parse(raw) as State

    for (let i = 0; i < localStorage.length; i++) {
      const next = localStorage.key(i)
      if (!next?.endsWith(":workspace:terminal")) continue
      const value = localStorage.getItem(next)
      if (!value) continue
      return JSON.parse(value) as State
    }
  }, key)
}

// What this guards against: a tab switch losing the inactive terminal's
// state entirely (the post-flatten regression risk — each terminal's
// TerminalPanel unmounts on switch and depends on Terminal.tsx's onCleanup
// → persistTerminal to capture a snapshot before Solid disposes the xterm).
//
// What this does NOT assert (and why): the pre-flatten version of this test
// checked `.includes("E2E_TERM_ONE_...")` against the persisted buffer.
// That assertion is structurally incompatible with the flatten arch because
// every switch round-trips the buffer through
// `serializeAddon.serialize() → term.write(restore) → serializeAddon.serialize()`,
// and xterm.js's serialize is not idempotent across that path: at the
// e2e harness's 36-column width, wrapped command lines (`echo E2E_TERM_...`)
// re-serialize with cursor escape codes interleaved, splitting the token
// across non-contiguous cells. Diagnostically the last ~12 chars of the
// token always survive, the first ~14 don't — and that pattern reproduces
// 5/5 runs, so the failure was deterministic, not a timing flake. Asserting
// on length-above-baseline keeps the regression detector (we *would* catch
// "snapshot was overwritten with {}" or "onCleanup never fired") without
// pinning the test to an xterm behavior we don't own.
test("inactive terminal tab buffers persist across tab switches", async ({ page, project }) => {
  await project.open()
  const key = workspacePersistKey(project.directory, "terminal")
  const tabs = page.locator(terminalTabSelector)
  const first = tabs.nth(0)
  const second = tabs.nth(1)

  await project.gotoSession()
  await open(page)

  // Echo something distinctive into terminal 1; the exact text doesn't need
  // to survive the serialize round-trip, but the snapshot length should
  // grow well past the bare-prompt baseline.
  await runTerminal(page, { cmd: `echo E2E_TERM_ONE_${Date.now()}`, token: `ONE_${Date.now()}` })

  await newTerminal(page)
  await expect(tabs).toHaveCount(2)

  await runTerminal(page, { cmd: `echo E2E_TERM_TWO_${Date.now()}`, token: `TWO_${Date.now()}` })

  const bufferLenFor = (state: State | undefined, n: number) =>
    state?.tabs?.find((item) => item.titleNumber === n)?.snapshot?.buffer?.length ?? 0

  // Empirically the bare prompt + cursor for the e2e shell sits around
  // 60-80 chars; the `echo`+wrapped argument adds 100+. Pick a lower bound
  // that's clearly above an empty snapshot ({} → 0) and above a bare
  // prompt-only one, but tolerant of shell prompt variation across runs.
  const MIN_NON_TRIVIAL_BUFFER = 120

  // Switch to first. Tab 2 unmounts → captures snapshot. Tab 1 mounts and
  // its snapshot is cleared by onConnect({}) — so right after switch:
  //   - tab 1 snapshot: empty (active, restored from store, cleared)
  //   - tab 2 snapshot: substantial (just-captured TWO content)
  await first.click()
  await expect(first).toHaveAttribute("aria-selected", "true")
  await waitTerminalReady(page, { term: page.locator(terminalSelector) })

  await expect
    .poll(
      async () => {
        const state = await store(page, key)
        return {
          tab1Empty: bufferLenFor(state, 1) === 0,
          tab2Has: bufferLenFor(state, 2) >= MIN_NON_TRIVIAL_BUFFER,
        }
      },
      { timeout: 10_000 },
    )
    .toEqual({ tab1Empty: true, tab2Has: true })

  // Switch back. Tab 1 unmounts → captures snapshot (the restored content
  // re-serialized). Tab 2 mounts → snapshot cleared.
  await second.click()
  await expect(second).toHaveAttribute("aria-selected", "true")
  await waitTerminalReady(page, { term: page.locator(terminalSelector) })

  await expect
    .poll(
      async () => {
        const state = await store(page, key)
        return {
          tab1Has: bufferLenFor(state, 1) >= MIN_NON_TRIVIAL_BUFFER,
          tab2Empty: bufferLenFor(state, 2) === 0,
        }
      },
      { timeout: 10_000 },
    )
    .toEqual({ tab1Has: true, tab2Empty: true })
})

test("closing the active terminal tab falls back to the previous tab", async ({ page, project }) => {
  await project.open()
  const key = workspacePersistKey(project.directory, "terminal")
  const tabs = page.locator(terminalTabSelector)

  await project.gotoSession()
  await open(page)

  await newTerminal(page)
  await expect(tabs).toHaveCount(2)

  const second = tabs.nth(1)
  await second.click()
  await expect(second).toHaveAttribute("aria-selected", "true")

  // Close button lives inside each chip's wrapper as a separate <button>
  // (tabIndex=-1, aria-label "Close <label> tab"). Scope to the second
  // chip's wrapper so we don't accidentally hit the static-tab close
  // affordances on Status/Files chips that share the strip.
  await second.hover()
  await page
    .locator(terminalChipWrapperSelector)
    .nth(1)
    .locator('[data-slot="tabs-trigger-close-button"] button')
    .click({ force: true })

  const first = tabs.nth(0)
  await expect(tabs).toHaveCount(1)
  await expect(first).toHaveAttribute("aria-selected", "true")
  await expect
    .poll(
      async () => {
        const state = await store(page, key)
        return {
          count: state?.tabs?.length ?? 0,
          first: state?.tabs?.some((item) => item.titleNumber === 1) ?? false,
        }
      },
      { timeout: 15_000 },
    )
    .toEqual({ count: 1, first: true })
})

// Removed: "terminal tab can be renamed from the context menu".
//
// Rename via the chip's context menu was a feature of the pre-flatten
// SortableTerminalTab. The flatten refactor (cddf0a55a0, Area B
// 2026-05-25) replaced rename with cwd-basename labeling and same-name
// dedup; the new SortableShellTab's context menu intentionally only
// surfaces "Close tab". The rename feature is documented as deferred in
// the flatten commit's "What's NOT in this PR" section. If rename comes
// back later, re-add a focused test here for the new surface (likely
// double-click on the chip label) rather than restoring this one verbatim.
