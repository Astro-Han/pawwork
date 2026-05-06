/**
 * todo-toggle.spec.ts @smoke
 *
 * Golden-path: todo dock renders circle / circle-check icons based on todo status,
 * after replacing the Checkbox primitive with Icon in slice 05.
 */
import type { Page } from "@playwright/test"
import {
  composerEvent,
  type ComposerDriverState,
  type ComposerWindow,
} from "../../src/testing/session-composer"
import { cleanupSession } from "../actions"
import { test, expect } from "../fixtures"

async function driverWrite(
  page: Page,
  sessionID: string,
  driver: ComposerDriverState | undefined,
) {
  await page.evaluate(
    (input: { event: string; sessionID: string; driver: ComposerDriverState | undefined }) => {
      const win = window as ComposerWindow
      const composer = win.__opencode_e2e?.composer
      if (!composer?.enabled) throw new Error("Composer e2e driver is not enabled")
      composer.sessions ??= {}
      const prev = composer.sessions[input.sessionID] ?? {}
      if (!input.driver) {
        delete composer.sessions[input.sessionID]
      } else {
        composer.sessions[input.sessionID] = { ...prev, driver: input.driver }
      }
      window.sessionStorage.setItem("__opencode_e2e_composer_sessions", JSON.stringify(composer.sessions))
      window.dispatchEvent(new CustomEvent(input.event, { detail: { sessionID: input.sessionID } }))
    },
    { event: composerEvent, sessionID, driver },
  )
}

test("todo dock shows circle for pending and circle-check for completed items @smoke", async ({
  page,
  project,
}) => {
  await page.addInitScript(() => {
    const win = window as ComposerWindow
    const saved = window.sessionStorage.getItem("__opencode_e2e_composer_sessions")
    const sessions = saved ? JSON.parse(saved) : {}
    win.__opencode_e2e = { ...win.__opencode_e2e, composer: { enabled: true, sessions } }
  })

  await project.open()

  const session = await project.sdk.session.create({ title: `e2e inputs todo icons` }).then((r) => r.data)
  if (!session?.id) throw new Error("Session create did not return an id")
  project.trackSession(session.id)

  try {
    await project.gotoSession(session.id)

    await driverWrite(page, session.id, {
      todos: [
        { content: "pending task", status: "pending", priority: "medium" },
        { content: "done task", status: "completed", priority: "high" },
        { content: "in-progress task", status: "in_progress", priority: "low" },
      ],
    })

    const dock = page.locator('[data-component="session-todo-dock"]')
    await expect(dock).toBeVisible({ timeout: 10_000 })

    const toggleBtn = dock.locator('[data-action="session-todo-toggle"]').first()
    await toggleBtn.click()

    const list = dock.locator('[data-slot="session-todo-list"]')
    await expect(list).toBeVisible({ timeout: 5_000 })

    const items = list.locator('[data-slot="session-todo-item"]')
    await expect(items).toHaveCount(3, { timeout: 5_000 })

    const pendingItem = list.locator('[data-slot="session-todo-item"][data-state="pending"]').first()
    const completedItem = list.locator('[data-slot="session-todo-item"][data-state="completed"]').first()

    await expect(pendingItem.locator('[data-component="icon"][data-size]')).toBeVisible()
    await expect(completedItem.locator('[data-component="icon"][data-size]')).toBeVisible()

    await driverWrite(page, session.id, undefined)
  } finally {
    await cleanupSession({ sdk: project.sdk, sessionID: session.id })
  }
})
