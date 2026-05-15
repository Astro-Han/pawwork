import { test, expect } from "../fixtures"

test("@smoke root route falls back to backend project when local store is empty", async ({ page, project }) => {
  await project.open()

  await page.evaluate(() => {
    const key = "pawwork.global.dat:server"
    const raw = localStorage.getItem(key)
    if (!raw) return
    const parsed = JSON.parse(raw) as { projects?: Record<string, unknown> }
    parsed.projects = {}
    localStorage.setItem(key, JSON.stringify(parsed))
  })

  await page.goto("/")

  await expect(page).toHaveURL(/\/[A-Za-z0-9_-]+\/session/)
})
