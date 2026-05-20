import type { Todo } from "@opencode-ai/sdk/v2/client"
import type { createSdk } from "../utils"
import { test } from "../fixtures"
import { openSidebar } from "../actions"
import { sessionItemSelector } from "../selectors"
import { composeGrid, snapOutputPath } from "./_compose"

type Sdk = ReturnType<typeof createSdk>

async function seedSessionTurn(input: { sdk: Sdk; sessionID: string }) {
  await input.sdk.session.prompt({
    sessionID: input.sessionID,
    noReply: true,
    parts: [{ type: "text", text: "todo dock restored snap seed" }],
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
  if (response.status !== 204) throw new Error(`updateTodos failed: ${response.status} ${await response.text()}`)
}

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

test("todo-dock-restored", async ({ page, project }) => {
  let sessionID: string | undefined
  await project.open({
    beforeGoto: async ({ sdk }) => {
      const session = await sdk.session.create({ title: "snap todo dock restored" }).then((res) => res.data)
      sessionID = session?.id
      if (sessionID) await seedSessionTurn({ sdk, sessionID })
    },
  })
  if (!sessionID) throw new Error("Session create did not return an id")
  project.trackSession(sessionID)

  await updateTodos({
    url: project.url,
    directory: project.directory,
    sessionID,
    todos: [
      { content: "Restored active task", status: "in_progress", priority: "high" },
      { content: "Queued follow-up task", status: "pending", priority: "medium" },
    ],
  })

  await openSidebar(page)
  await page.locator(sessionItemSelector(sessionID)).click()
  await page.locator('[data-component="session-todo-dock"]').waitFor({ state: "visible", timeout: 30_000 })

  const composer = page.locator('[data-component="session-composer-column"]')
  const out = snapOutputPath("todo-dock-restored")
  await composeGrid([{ name: "restored todo dock", buf: await composer.screenshot() }], out)
  process.stdout.write(`\n[snap] todo-dock-restored grid -> ${out}\n\n`)
})
