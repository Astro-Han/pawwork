import type { Todo } from "@opencode-ai/sdk/v2/client"
import type { createSdk } from "../utils"
import { test } from "../fixtures"
import { openRightPanel, openSidebar } from "../actions"
import { sessionItemSelector } from "../selectors"
import { composeGrid, snapOutputPath } from "./_compose"

type Sdk = ReturnType<typeof createSdk>

// Slice 3 of Area B (#602) replaces the right-panel Status todo dots with the
// canonical todo widget marker (Icon + 13×13 pw-spin ring) per DESIGN.md L201.
// This target screenshots the right panel after seeding todos in all four
// states so the marker rendering itself has a durable baseline; the composer
// dock variant lives in todo-dock-restored.snap.ts.

async function seedSessionTurn(input: { sdk: Sdk; sessionID: string }) {
  await input.sdk.session.prompt({
    sessionID: input.sessionID,
    noReply: true,
    parts: [{ type: "text", text: "status summary todos snap seed" }],
  })
}

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

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

test("status-summary-todos", async ({ page, project }) => {
  let sessionID: string | undefined
  await project.open({
    beforeGoto: async ({ sdk }) => {
      const session = await sdk.session.create({ title: "snap status summary todos" }).then((res) => res.data)
      sessionID = session?.id
      if (sessionID) await seedSessionTurn({ sdk, sessionID })
    },
  })
  if (!sessionID) throw new Error("Session create did not return an id")
  project.trackSession(sessionID)

  // Cover every marker variant: completed (circle-check) / in_progress (13×13 spin ring)
  // / pending (circle outline) / cancelled (circle outline + line-through).
  await updateTodos({
    url: project.url,
    directory: project.directory,
    sessionID,
    todos: [
      { content: "Wire status summary markers", status: "completed", priority: "high" },
      { content: "Cover all four states in snap", status: "in_progress", priority: "high" },
      { content: "Queue follow-up cleanup", status: "pending", priority: "medium" },
      { content: "Notify user for review", status: "cancelled", priority: "low" },
    ],
  })

  // Navigate via sidebar click — this matches todo-dock-restored.snap.ts and
  // gives globalSync time to publish session_todo updates before the Status tab
  // body is queried.
  await openSidebar(page)
  await page.locator(sessionItemSelector(sessionID)).click()

  const panel = await openRightPanel(page)

  // Status is the default sidePanelTab per RIGHT_PANEL_TAB_VALUES normalisation,
  // so no tab switch is required. Wait until at least one todo row is on screen
  // to confirm the Status tab body has actually rendered before snapping.
  await page
    .locator('[data-slot="status-summary-todo"]')
    .first()
    .waitFor({ state: "visible", timeout: 30_000 })

  const shot = await panel.screenshot()
  const out = snapOutputPath("status-summary-todos")
  await composeGrid([{ name: "right-panel status todos", buf: shot }], out)
  process.stdout.write(`\n[snap] status-summary-todos grid -> ${out}\n\n`)
})
