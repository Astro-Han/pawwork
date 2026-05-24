import { expect, type Page } from "@playwright/test"
import type { Todo } from "@opencode-ai/sdk/v2/client"
import { openRightPanel, rightPanelTabList, withSession } from "../actions"
import { test } from "../fixtures"
import { promptSelector } from "../selectors"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

async function updateTodos(
  project: { url: string; directory: string },
  input: { sessionID: string; todos: Array<Pick<Todo, "content" | "status" | "priority"> & Partial<Pick<Todo, "id">>> },
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

async function captureComposerBottom(page: Page): Promise<Shot> {
  const prompt = page.locator(promptSelector).first()
  await expect(prompt).toBeVisible()
  const box = await prompt.boundingBox()
  const viewport = page.viewportSize()
  if (!box || !viewport) throw new Error("snap: prompt box unavailable")

  const x = Math.max(0, Math.floor(box.x - 24))
  const y = Math.max(0, Math.floor(box.y - 220))
  const width = Math.min(viewport.width - x, Math.ceil(box.width + 48))
  const height = Math.min(viewport.height - y, 300)

  return {
    name: "composer-bottom-no-todo-dock",
    buf: await page.screenshot({ clip: { x, y, width, height } }),
  }
}

test("todo-status-only", async ({ page, project }) => {
  test.setTimeout(180_000)

  await project.open()
  await withSession(project.sdk, "snap todo status-only", async (session) => {
    project.trackSession(session.id)
    await project.gotoSession(session.id)

    const content = "snap todo lives in Status only"
    await updateTodos(
      { url: project.url, directory: project.directory },
      {
        sessionID: session.id,
        todos: [
          { content: "completed setup", status: "completed", priority: "low" },
          { content, status: "in_progress", priority: "medium" },
          { content: "pending follow-up", status: "pending", priority: "medium" },
        ],
      },
    )

    const rightPanel = await openRightPanel(page)
    const statusTab = rightPanelTabList(page).getByRole("tab", { name: "Status", exact: true })
    await statusTab.click()
    await expect(statusTab).toHaveAttribute("aria-selected", "true")

    const todoRow = rightPanel.locator('[data-slot="status-summary-todo"]').filter({ hasText: content }).first()
    await expect(todoRow).toHaveAttribute("data-state", "in_progress", { timeout: 10_000 })
    await expect(page.locator('[data-component="session-todo-dock"]')).toHaveCount(0)

    const shots: Shot[] = [
      { name: "full-shell-status-todos", buf: await page.screenshot({ fullPage: false }) },
      await captureComposerBottom(page),
    ]

    const out = snapOutputPath("todo-status-only")
    await composeGrid(shots, out, { cols: 2 })
    process.stdout.write(`\n[snap] todo-status-only grid -> ${out}\n\n`)
  })
})
