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

async function enableComposerStateProbe(page: { addInitScript: (script: () => void) => Promise<void> | void }) {
  await page.addInitScript(() => {
    const win = window as Window & {
      __opencode_e2e?: {
        composer?: {
          enabled?: boolean
          sessions?: Record<string, unknown>
        }
      }
    }
    win.__opencode_e2e = {
      ...win.__opencode_e2e,
      composer: {
        enabled: true,
        sessions: {},
      },
    }
  })
}

async function readComposerState(
  page: { evaluate: <T>(fn: (sessionID: string) => T, arg: string) => Promise<T> },
  sessionID: string,
) {
  return page.evaluate((id) => {
    const win = window as Window & {
      __opencode_e2e?: {
        composer?: {
          sessions?: Record<string, { stateProbe?: { count: number; states: string[]; openingSamples?: boolean[] } }>
        }
      }
    }
    return win.__opencode_e2e?.composer?.sessions?.[id]?.stateProbe ?? null
  }, sessionID)
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

test("historical tool-parts todo restores without entrance animation on sidebar session switch", async ({
  page,
  llm,
  project,
}) => {
  await enableComposerStateProbe(page)
  await project.open()

  await llm.tool("todowrite", {
    todos: [{ content: "historical parts task", status: "in_progress", priority: "high" }],
  })
  await llm.text("todo started")
  const sessionID = await project.prompt("Create a todo that should be historical after reload.")

  const other = await project.sdk.session.create({ title: "e2e todo dock switch target" }).then((res) => res.data)
  if (!other?.id) throw new Error("Session create did not return an id")
  await seedSessionTurn({ sdk: project.sdk, sessionID: other.id })
  project.trackSession(other.id)

  await project.gotoSession(other.id)
  await page.reload()
  await project.gotoSession(other.id)

  await openSidebar(page)
  await page.locator(sessionItemSelector(sessionID)).click()

  await expect
    .poll(async () => readComposerState(page, sessionID), { timeout: 30_000 })
    .toMatchObject({ count: 1, states: ["in_progress"] })

  const state = await readComposerState(page, sessionID)
  expect(state?.openingSamples ?? []).not.toContain(true)
})
