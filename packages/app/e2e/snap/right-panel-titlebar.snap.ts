import { expect, type Page } from "@playwright/test"
import type { Todo } from "@opencode-ai/sdk/v2/client"
import { openRightPanel, openSidebar } from "../actions"
import { test } from "../fixtures"
import { sessionItemSelector } from "../selectors"
import { applyDarkModeForTests } from "../utils"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

// Seed four todos covering every status — completed / in_progress / pending /
// cancelled — so the Status tab shows real content (not the "No todos yet"
// empty state). Same approach as status-summary-todos.snap.ts.
async function updateTodos(input: {
  url: string
  directory: string
  sessionID: string
  todos: Array<Pick<Todo, "content" | "status" | "priority">>
}) {
  const response = await fetch(
    `${input.url}/session/__e2e/update-todos?directory=${encodeURIComponent(input.directory)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: input.sessionID, todos: input.todos }),
    },
  )
  if (response.status !== 204) {
    throw new Error(`updateTodos failed: ${response.status} ${await response.text()}`)
  }
}

// Right-panel + titlebar shell composition. This target exists to verify the
// visual contract between the titlebar's right edge and the right panel:
//
//   1) The right-panel tab row (Status / Files / …) lives INSIDE the titlebar,
//      portalled from <SessionSidePanel> into <Titlebar>'s `pawwork-titlebar-tabs`
//      slot, so the tabs read as window chrome instead of a second toolbar.
//   2) The titlebar's `border-l border-border-weaker` at the tab slot's left
//      edge must align pixel-for-pixel with the panel body's `border-l` below it
//      — one continuous 1px separator from top of titlebar to bottom of viewport.
//
// We capture full-viewport (fullPage: false) so the seam between chrome and
// body is visible in one frame. Component-level crops would hide exactly the
// alignment we are checking. Both light and dark are captured because the seam
// is most fragile in dark mode where `--border-weaker` is only a hair lighter
// than `--bg-base`.

// reducedMotion: "reduce" trips the layout shell's `motion-reduce:transition-none`,
// which kills the 240ms --right-panel-width transition. Without this, Playwright's
// stability check keeps blocking clicks on tabs/buttons sitting on the moving slot.
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, reducedMotion: "reduce" })

// Open Files and Review in the right-panel tab strip via the "+" dropdown.
// We want the snap to capture the multi-tab layout (active indicator, gap
// between tabs, alignment with the body) rather than just the single Status
// pill. Status is non-closable so always present; the other two cover the
// closable + active-state variants.
async function openExtraTabs(page: Page) {
  // Use the registered command keybinds rather than clicking the "+" dropdown.
  // The dropdown trigger lives in the portalled titlebar tab slot, where
  // Playwright's hit-test mis-attributes pointer-events to the right-panel
  // body below (z-stacking false positive). Keybinds bypass the issue entirely
  // and are stable across platforms via ControlOrMeta.
  //   fileTree.toggle → mod+\
  //   review.toggle   → mod+shift+r
  // Registered in packages/app/src/pages/session/use-session-commands.tsx.
  // Focus the main app region first so the global keybind dispatcher receives
  // the events (Playwright otherwise can dispatch from the document root before
  // any element is focused).
  await page.locator("main").first().click()
  await page.keyboard.press("ControlOrMeta+\\")
  await page.keyboard.press("ControlOrMeta+Shift+R")
  // Wait for the openTabs side-effect to propagate before we click Status —
  // otherwise the snap can race the tab list update and capture a single-tab
  // strip when we expect three.
  await expect.poll(() => page.getByRole("tab").count(), { timeout: 5_000 }).toBe(3)
  // Click Status so the snap captures Status-active (the default landing tab)
  // rather than whichever extra tab opened last.
  await page.getByRole("tab", { name: "Status" }).click()
}

async function captureRightPanelShell(
  page: Page,
  label: "light" | "dark",
  project: { url: string; directory: string },
  sessionID: string,
  todos: Array<Pick<Todo, "content" | "status" | "priority">>,
): Promise<Shot> {
  // Sidebar → click session item: same navigation as status-summary-todos.snap.ts.
  // Direct route navigation is fragile because session routes carry directory state
  // that the sidebar entry already encodes.
  await openSidebar(page)
  await page.locator(sessionItemSelector(sessionID)).click()
  await openRightPanel(page)
  await openExtraTabs(page)
  // Re-seed todos every capture. applyDarkModeForTests calls page.reload, which
  // wipes the in-memory sync cache; re-posting is cheaper and more deterministic
  // than waiting for the session_todo stream to re-hydrate after reload.
  await updateTodos({ url: project.url, directory: project.directory, sessionID, todos })
  await expect
    .poll(() => page.locator('[data-slot="status-summary-todo"]').count(), { timeout: 15_000 })
    .toBe(todos.length)
  // Move the pointer to a neutral spot so no hover/tooltip is captured on top
  // of the tab strip (the openRightPanel button otherwise leaves a tooltip).
  await page.mouse.move(0, 0)
  // animations: "disabled" freezes the right-panel width transition so width is
  // stable when we snapshot, otherwise the tab portal's `right: var(--right-panel-width)`
  // can capture mid-tween.
  return { name: label, buf: await page.screenshot({ fullPage: false, animations: "disabled" }) }
}

test("right-panel-titlebar", async ({ page, project }) => {
  test.setTimeout(180_000)

  let sessionID: string | undefined
  await project.open({
    beforeGoto: async ({ sdk }) => {
      const session = await sdk.session.create({ title: "snap right panel titlebar" }).then((res) => res.data)
      sessionID = session?.id
    },
  })
  if (!sessionID) throw new Error("Session create did not return an id")
  project.trackSession(sessionID)

  // Realistic Progress content — five todos across every marker variant. Picked
  // from a believable PR cleanup session so the snap reads as a real moment of
  // work, not lorem-ipsum placeholders.
  const todos: Array<Pick<Todo, "content" | "status" | "priority">> = [
    { content: "Audit session-status-summary tokens against DESIGN.md", status: "completed", priority: "high" },
    { content: "Wire portal slot in titlebar for right-panel tabs", status: "completed", priority: "high" },
    { content: "Verify hairline alignment across mac & windows chrome", status: "in_progress", priority: "high" },
    { content: "Sweep stale 'No connections' empty-state copy", status: "pending", priority: "medium" },
    { content: "Drop the brand underline on active tab", status: "cancelled", priority: "low" },
  ]

  const shots: Shot[] = []

  shots.push(await captureRightPanelShell(page, "light", project, sessionID, todos))

  await applyDarkModeForTests(page)
  shots.push(await captureRightPanelShell(page, "dark", project, sessionID, todos))

  const out = snapOutputPath("right-panel-titlebar")
  await composeGrid(shots, out)
  process.stdout.write(`\n[snap] right-panel-titlebar grid -> ${out}\n\n`)
})
