import type { Page } from "@playwright/test"
import { test, expect } from "../fixtures"
import { waitSession, waitTerminalReady } from "../actions"
import { terminalSelector } from "../selectors"
import { terminalToggleKey } from "../utils"

type PersistedTerminalStateV2 = {
  version: 2
  activeTabID?: string
  tabs: Array<{
    tabID: string
    title: string
    titleNumber: number
    order: number
    snapshot?: {
      buffer?: string
      cursor?: number
      scrollY?: number
      size?: { rows: number; cols: number }
    }
  }>
}

function readPersistedTerminalEntry() {
  const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter(
    (key): key is string => !!key && key.endsWith(":workspace:terminal"),
  )
  for (const key of keys) {
    const raw = localStorage.getItem(key)
    if (!raw) continue
    const state = JSON.parse(raw) as PersistedTerminalStateV2
    if (state.version === 2) return { key, state }
  }
  return undefined
}

async function openTerminal(page: Page) {
  const terminal = page.locator(terminalSelector).first()
  const visible = await terminal.isVisible().catch(() => false)
  if (!visible) await page.keyboard.press(terminalToggleKey)
  await waitTerminalReady(page, { term: terminal })
  return terminal
}

test("restored legacy terminal state creates a fresh runtime pty", async ({ page, project }) => {
  const oldRequests: string[] = []

  page.on("request", (request) => {
    const url = request.url()
    if (url.includes("/pty/pty_old")) oldRequests.push(url)
  })
  page.on("websocket", (socket) => {
    const url = socket.url()
    if (url.includes("/pty/pty_old")) oldRequests.push(url)
  })

  await project.open()
  const initialTerminal = await openTerminal(page)
  const initialTabID = await initialTerminal.getAttribute("data-pty-id")
  expect(initialTabID).toMatch(/^tab_/)

  const entry = await expect
    .poll(() => page.evaluate(readPersistedTerminalEntry), { timeout: 5_000 })
    .toMatchObject({ state: { version: 2 } })
    .then(() => page.evaluate(readPersistedTerminalEntry))
  if (!entry) throw new Error("Terminal storage entry was not persisted")

  await page.evaluate((key) => {
    localStorage.setItem(
      key,
      JSON.stringify({
        active: "pty_old",
        all: [
          {
            id: "pty_old",
            title: "Legacy terminal",
            titleNumber: 1,
            rows: 24,
            cols: 80,
            buffer: "LEGACY_BUFFER",
            cursor: 13,
            scrollY: 0,
          },
        ],
      }),
    )
  }, entry.key)
  oldRequests.length = 0
  await page.reload()
  await waitSession(page, { directory: project.directory, serverUrl: project.url, allowAnySession: true })

  const terminal = await openTerminal(page)
  const tabID = await terminal.getAttribute("data-pty-id")
  expect(tabID).toMatch(/^tab_/)
  expect(tabID).not.toBe("pty_old")

  const state = await expect
    .poll(() => page.evaluate(readPersistedTerminalEntry), { timeout: 5_000 })
    .toMatchObject({ state: { version: 2 } })
    .then(() => page.evaluate(readPersistedTerminalEntry).then((entry) => entry?.state))

  expect(oldRequests).toEqual([])
  expect(state?.version).toBe(2)
  expect(state?.activeTabID).toBe(tabID)
  expect(state?.tabs).toHaveLength(1)
  expect(state?.tabs[0]?.tabID).toBe(tabID)
  expect(state?.tabs[0]?.title).toBe("Legacy terminal")
  expect(state?.tabs[0]?.order).toBe(0)
  expect(JSON.stringify(state)).not.toContain("pty_old")
  expect(JSON.stringify(state)).not.toContain("runtimePty")
})
