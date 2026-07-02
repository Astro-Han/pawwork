import { test, expect } from "../fixtures"
import { cleanupSession, openSidebar, waitSessionSaved } from "../actions"
import { sessionItemSelector } from "../selectors"
import { modKey } from "../utils"

// Route-flip semantics for the first-class surfaces (/settings /automations
// /skills): entering flips the URL, closing returns to the recorded origin,
// chains unwind one close at a time, and a dead origin falls back to the
// project session home instead of a 404 or a deleted session.

function pathname(page: { url(): string }) {
  return new URL(page.url()).pathname
}

test("@smoke opening a surface flips the URL and Escape returns to the origin session", async ({ page, project }) => {
  await project.open()
  // A concrete session: the close fallback is the session home, so an origin
  // without a session id could not tell "returned to origin" from "fell back".
  await project.user("surface origin")
  const origin = pathname(page)
  await openSidebar(page)

  await page.locator('[data-action="pawwork-automations-open"]').click()
  await expect(page.locator('[data-component="automations-page"]')).toBeVisible()
  expect(pathname(page)).toBe("/automations")

  await page.keyboard.press("Escape")
  await expect(page.locator('[data-component="automations-page"]')).toHaveCount(0)
  await expect.poll(() => pathname(page)).toBe(origin)
})

test("re-clicking the entry of an open surface is a no-op (no extra history entry)", async ({ page, project }) => {
  await project.open()
  const origin = pathname(page)
  await openSidebar(page)

  const entry = page.locator('[data-action="pawwork-automations-open"]')
  await entry.click()
  await expect(page.locator('[data-component="automations-page"]')).toBeVisible()

  // The sidebar stays live on the surface; a second click must not navigate
  // again. If it pushed a duplicate entry, going back would land on
  // /automations instead of the session we came from.
  await entry.click()
  await expect(page.locator('[data-component="automations-page"]')).toBeVisible()
  expect(pathname(page)).toBe("/automations")

  await page.goBack()
  await expect.poll(() => pathname(page)).toBe(origin)
})

test("surface-to-surface chain unwinds one close at a time", async ({ page, project }) => {
  await project.open()
  // See the smoke test: origin must carry a session id to be distinguishable
  // from the fallback.
  await project.user("chain origin")
  const origin = pathname(page)
  await openSidebar(page)

  await page.locator('[data-action="pawwork-automations-open"]').click()
  await expect(page.locator('[data-component="automations-page"]')).toBeVisible()

  // Settings opened on top of automations records /automations as its origin.
  await page.keyboard.press(`${modKey}+Comma`)
  const settingsPage = page.locator('[data-component="settings-page"]')
  await expect(settingsPage).toBeVisible()
  expect(pathname(page)).toBe("/settings")

  // First close returns to automations, not all the way to the session.
  await page.keyboard.press("Escape")
  await expect(settingsPage).toHaveCount(0)
  await expect(page.locator('[data-component="automations-page"]')).toBeVisible()
  expect(pathname(page)).toBe("/automations")

  // Second close finishes the unwind back to the original session.
  await page.keyboard.press("Escape")
  await expect(page.locator('[data-component="automations-page"]')).toHaveCount(0)
  await expect.poll(() => pathname(page)).toBe(origin)
})

test("returning to a surface via the titlebar's own back keeps close-to-origin intact", async ({ page, project }) => {
  await project.open()
  // See the smoke test: origin must carry a session id to be distinguishable
  // from the fallback.
  await project.user("titlebar back origin")
  const origin = pathname(page)
  await openSidebar(page)

  await page.locator('[data-action="pawwork-automations-open"]').click()
  await expect(page.locator('[data-component="automations-page"]')).toBeVisible()

  await page.keyboard.press(`${modKey}+Comma`)
  const settingsPage = page.locator('[data-component="settings-page"]')
  await expect(settingsPage).toBeVisible()

  // The titlebar back command replays entries from its own stack, not browser
  // history — each entry must carry its navigation state, or this Escape
  // would fall back to the session home instead of the recorded origin.
  await page.keyboard.press(`${modKey}+BracketLeft`)
  await expect(settingsPage).toHaveCount(0)
  await expect(page.locator('[data-component="automations-page"]')).toBeVisible()
  expect(pathname(page)).toBe("/automations")

  await page.keyboard.press("Escape")
  await expect(page.locator('[data-component="automations-page"]')).toHaveCount(0)
  await expect.poll(() => pathname(page)).toBe(origin)
})

test("closing a surface whose origin session was deleted falls back to the session home", async ({
  page,
  project,
  backend,
}) => {
  await project.open()
  // Two real, distinct sessions seeded through the sdk (project.user() would
  // reuse the session currently on screen). The kept one keeps the synced
  // session list non-empty after the origin is deleted, so the close-time
  // validation can tell "session gone" apart from "sync not loaded yet".
  const seedSession = async (title: string) => {
    const created = await project.sdk.session.create({ title })
    const id = created.data?.id
    if (!id) throw new Error(`failed to create session "${title}"`)
    project.trackSession(id)
    await project.sdk.session.prompt({ sessionID: id, noReply: true, parts: [{ type: "text", text: title }] })
    await waitSessionSaved(project.directory, id, 90_000, backend.url)
    return id
  }
  const keptID = await seedSession("keep me")
  const originID = await seedSession("origin session")
  await project.gotoSession(originID)
  await openSidebar(page)
  await expect(page.locator(sessionItemSelector(keptID))).toBeVisible({ timeout: 30_000 })

  await page.locator('[data-action="pawwork-automations-open"]').click()
  await expect(page.locator('[data-component="automations-page"]')).toBeVisible()

  await cleanupSession({ sessionID: originID, directory: project.directory, serverUrl: backend.url })
  // The live sidebar is the user-visible sync signal that the deletion landed.
  await expect(page.locator(sessionItemSelector(originID))).toHaveCount(0)
  await expect(page.locator(sessionItemSelector(keptID))).toBeVisible()

  await page.keyboard.press("Escape")
  await expect(page.locator('[data-component="automations-page"]')).toHaveCount(0)
  // Lands somewhere in the project's session area — never on the deleted one.
  await expect.poll(() => pathname(page)).toMatch(new RegExp(`^/${project.slug}/session`))
  expect(pathname(page)).not.toContain(originID)
})

test("a fresh page load on /settings stays on settings instead of autoselecting a project", async ({
  page,
  project,
}) => {
  await project.open()

  // Boot the app directly at /settings (what a mid-session reload on the
  // route looks like). Startup autoselect must not steal the route once the
  // project list syncs in.
  await page.goto("/settings")
  await expect(page.locator('[data-component="settings-page"]')).toBeVisible()

  const stolen = await page
    .waitForURL(/\/session/, { timeout: 3000 })
    .then(() => true)
    .catch(() => false)
  expect(stolen).toBe(false)
  expect(pathname(page)).toBe("/settings")
})
