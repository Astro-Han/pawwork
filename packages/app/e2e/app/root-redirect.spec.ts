import { test, expect } from "../fixtures"
import type { Page, Route } from "@playwright/test"

async function seedServerWithoutProjects(page: Page, serverUrl: string) {
  await page.addInitScript((serverUrl) => {
    const key = "pawwork.global.dat:server"
    localStorage.setItem(key, JSON.stringify({ list: [serverUrl], projects: {}, lastProject: {} }))
    localStorage.setItem("pawwork.settings.dat:defaultServerUrl", serverUrl)
  }, serverUrl)
}

async function delayProjectDiscovery(page: Page) {
  let releaseStartup!: () => void
  const startupPending = new Promise<void>((resolve) => {
    releaseStartup = resolve
  })
  const delayDiscovery = async (route: Route) => {
    await startupPending
    await route.continue()
  }
  await page.route("**/path", delayDiscovery)
  await page.route("**/project", delayDiscovery)
  return releaseStartup
}

test("@smoke root route falls back to backend project when local store is empty", async ({ page, backend }) => {
  await seedServerWithoutProjects(page, backend.url)

  await page.goto("/")

  await expect(page).toHaveURL(/\/[A-Za-z0-9_-]+\/session/)
})

test("root route shows startup state while backend project discovery is pending", async ({ page, backend }) => {
  await seedServerWithoutProjects(page, backend.url)
  const releaseStartup = await delayProjectDiscovery(page)

  await page.goto("/")

  const main = page.locator('[data-component="desktop-shell-main"]')
  await expect(main).toBeVisible()
  await expect(main.locator('[data-component="app-startup-pending"]')).toBeVisible()

  releaseStartup()
  await expect(page).toHaveURL(/\/[A-Za-z0-9_-]+\/session/)
})

test("direct session route does not wait for startup autoselect discovery", async ({ page, backend, slug }) => {
  await seedServerWithoutProjects(page, backend.url)
  const releaseStartup = await delayProjectDiscovery(page)

  await page.goto(`/${slug}/session`)

  await expect(page.locator('[data-component="session-new-home"]')).toBeVisible()
  await expect(page.locator('[data-component="app-startup-pending"]')).toHaveCount(0)

  releaseStartup()
})
