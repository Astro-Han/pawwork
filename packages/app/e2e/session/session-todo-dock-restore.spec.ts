import type { Todo } from "@opencode-ai/sdk/v2/client"
import type { createSdk } from "../utils"
import { test, expect } from "../fixtures"
import { openSidebar } from "../actions"
import { sessionItemSelector } from "../selectors"

type Sdk = ReturnType<typeof createSdk>

type ProjectSeed = {
  url: string
  directory: string
  sdk: Sdk
}

async function seedSessionTurn(input: { sdk: ProjectSeed["sdk"]; sessionID: string }) {
  await input.sdk.session.prompt({
    sessionID: input.sessionID,
    noReply: true,
    parts: [{ type: "text", text: "todo dock restored session seed" }],
  })
}

async function updateTodos(
  project: ProjectSeed,
  input: { sessionID: string; todos: Array<Pick<Todo, "content" | "status" | "priority">> },
) {
  const response = await fetch(
    `${project.url}/session/__e2e/update-todos?directory=${encodeURIComponent(project.directory)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  )
  expect(response.status, await response.text()).toBe(204)
}

test("todo dock restores without entrance animation on session entry", async ({ page, project }) => {
  let session: { id: string; title: string } | undefined
  await project.open({
    beforeGoto: async ({ sdk }) => {
      session = await sdk.session.create({ title: "e2e todo dock restored entry" }).then((res) => res.data)
      if (session?.id) await seedSessionTurn({ sdk, sessionID: session.id })
    },
  })
  if (!session?.id) throw new Error("Session create did not return an id")
  project.trackSession(session.id)

  await updateTodos(
    { url: project.url, directory: project.directory, sdk: project.sdk },
    {
      sessionID: session.id,
      todos: [
        { content: "restored first task", status: "pending", priority: "high" },
        { content: "restored second task", status: "in_progress", priority: "medium" },
      ],
    },
  )
  await page.clock.install()

  await openSidebar(page)
  await page.locator(sessionItemSelector(session.id)).click()
  const todoDock = page.locator('[data-component="session-todo-dock"]')
  await expect(todoDock).toHaveCount(1, { timeout: 10_000 })

  const restoredHeight = await todoDock.evaluate((el) => {
    if (!(el instanceof HTMLElement)) return 0
    return Number.parseFloat(el.style.maxHeight || getComputedStyle(el).maxHeight)
  })
  expect(restoredHeight).toBeGreaterThanOrEqual(35)
})
