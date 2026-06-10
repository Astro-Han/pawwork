import { test, expect } from "../fixtures"
import { cleanupSession, cleanupTestProject, createTestProject, defocus, openSidebar, waitSession } from "../actions"
import { pawworkSidebarSelector, promptSelector } from "../selectors"

test("users can pin, rename, and regroup sessions in the PawWork sidebar", async ({ page, sdk, gotoSession }) => {
  const stamp = Date.now()
  const one = await sdk.session.create({ title: `Ops weekly ${stamp}` }).then((r) => r.data)
  const two = await sdk.session.create({ title: `Board draft ${stamp}` }).then((r) => r.data)

  if (!one?.id || !two?.id) throw new Error("missing session ids")

  await gotoSession(one.id)
  await openSidebar(page)

  const sidebar = page.locator(pawworkSidebarSelector).first()
  const row = sidebar.locator(`[data-session-id="${two.id}"]`).first()

  await row.hover()
  await row.locator('[data-action="session-row-menu"]').click()
  await page.getByRole("menuitem", { name: /pin session/i }).click()
  await expect(sidebar.locator(`[data-component="pawwork-sidebar-pinned"] [data-session-id="${two.id}"]`)).toBeVisible()

  const renameRow = sidebar.locator(`[data-session-id="${one.id}"]`).first()
  await renameRow.hover()
  await renameRow.locator('[data-action="session-row-menu"]').click()
  await page.getByRole("menuitem", { name: /rename/i }).click()
  const dialog = page.locator('[data-component="dialog"]')
  await expect(dialog).toBeVisible()
  const input = dialog.getByRole("textbox")
  await expect(input).toBeVisible()
  await expect(input).toBeFocused()
  await input.fill(`Ops weekly renamed ${stamp}`)
  await input.press("Enter")
  await expect(dialog).toBeHidden()
  await expect(sidebar.locator(`[data-session-id="${one.id}"]`)).toContainText(`Ops weekly renamed ${stamp}`)

  await sidebar.locator('[data-action="pawwork-sort-trigger"]').click()
  await page.locator('[data-action="pawwork-sort-option"][data-value="project"]').click()
  await expect(sidebar.locator('[data-component="pawwork-group-header"]')).toHaveCount(1)
})

test("users can delete a session from the PawWork sidebar", async ({ page, sdk, gotoSession }) => {
  const stamp = Date.now()
  const session = await sdk.session.create({ title: `e2e sidebar delete ${stamp}` }).then((r) => r.data)

  if (!session?.id) throw new Error("missing session id")

  await gotoSession(session.id)
  await openSidebar(page)

  const sidebar = page.locator(pawworkSidebarSelector).first()
  const row = sidebar.locator(`[data-session-id="${session.id}"]`).first()
  await expect(row).toBeVisible()

  await row.hover()
  await row.locator('[data-action="session-row-menu"]').click()
  await page.getByRole("menuitem", { name: /^delete$/i }).click()

  const dialog = page.locator('[data-component="dialog"]')
  await expect(dialog).toBeVisible()
  await dialog.getByRole("button", { name: /^delete$/i }).click()

  await expect
    .poll(
      async () => {
        const data = await sdk.session
          .get({ sessionID: session.id })
          .then((r) => r.data)
          .catch(() => undefined)
        return data?.id
      },
      { timeout: 30_000 },
    )
    .toBeUndefined()

  await expect(sidebar.locator(`[data-session-id="${session.id}"]`)).toHaveCount(0)
})

test("session row menu does not expose raw export as a troubleshooting entry", async ({ page, sdk, gotoSession }) => {
  const stamp = Date.now()
  const session = await sdk.session.create({ title: `e2e sidebar diagnostics ${stamp}` }).then((r) => r.data)

  if (!session?.id) throw new Error("missing session id")

  try {
    await gotoSession(session.id)
    await openSidebar(page)

    const sidebar = page.locator(pawworkSidebarSelector).first()
    const row = sidebar.locator(`[data-session-id="${session.id}"]`).first()
    await expect(row).toBeVisible()

    await row.hover()
    await row.locator('[data-action="session-row-menu"]').click()

    await expect(page.getByRole("menuitem", { name: /export session/i })).toHaveCount(0)
    await expect(page.getByRole("menuitem", { name: /diagnostics package/i })).toHaveCount(0)
  } finally {
    await cleanupSession({ sdk, sessionID: session.id })
  }
})

test("previous and next session follow time order across PawWork projects", async ({ page, backend, project }) => {
  const stamp = Date.now()
  const other = await createTestProject({ serverUrl: backend.url })
  const otherSdk = backend.sdk(other)
  let targetID = ""
  let sourceID = ""

  await page.addInitScript(() => {
    localStorage.setItem("pawwork.global.dat:layout.page", JSON.stringify({ pawworkSortMode: "time" }))
  })

  try {
    const target = await otherSdk.session.create({ title: `e2e nav target ${stamp}` }).then((r) => r.data)
    if (!target?.id) throw new Error("Target session create did not return an id")
    targetID = target.id

    await project.open({
      extra: [other],
      beforeGoto: async ({ sdk }) => {
        const source = await sdk.session.create({ title: `e2e nav source ${stamp}` }).then((r) => r.data)
        if (!source?.id) throw new Error("Source session create did not return an id")
        sourceID = source.id
        project.trackSession(source.id)
      },
    })
    project.trackDirectory(other)
    project.trackSession(targetID, other)

    await project.gotoSession(sourceID)
    await openSidebar(page)

    const sidebar = page.locator(pawworkSidebarSelector).first()
    await expect(sidebar.locator(`[data-session-id="${sourceID}"]`)).toBeVisible()
    await expect(sidebar.locator(`[data-session-id="${targetID}"]`)).toBeVisible()

    await defocus(page)
    await page.keyboard.press("Alt+ArrowDown")

    await waitSession(page, { directory: other, sessionID: targetID, serverUrl: backend.url })
    await expect(page.locator(promptSelector)).toBeVisible()
  } finally {
    if (targetID) await cleanupSession({ sdk: otherSdk, sessionID: targetID })
    await cleanupTestProject(other)
  }
})

test("next session expands a collapsed project group before navigating", async ({ page, backend, directory, sdk, gotoSession }) => {
  const stamp = Date.now()
  const target = await sdk.session.create({ title: `e2e collapsed target ${stamp}` }).then((r) => r.data)
  const source = await sdk.session.create({ title: `e2e collapsed source ${stamp}` }).then((r) => r.data)

  if (!target?.id || !source?.id) throw new Error("missing session ids")

  try {
    await gotoSession(source.id)
    await openSidebar(page)

    const sidebar = page.locator(pawworkSidebarSelector).first()
    await sidebar.locator('[data-action="pawwork-sort-trigger"]').click()
    await page.locator('[data-action="pawwork-sort-option"][data-value="project"]').click()

    const header = sidebar.locator('[data-action="pawwork-group-toggle"]').first()
    const content = sidebar.locator('[data-component="pawwork-group-content"]').first()
    await expect(header).toBeVisible()
    await header.click()
    await expect(content).toHaveAttribute("data-collapsed", "true")

    await defocus(page)
    await page.keyboard.press("Alt+ArrowDown")

    await waitSession(page, { directory, sessionID: target.id, serverUrl: backend.url })
    await expect(content).not.toHaveAttribute("data-collapsed", "true")
  } finally {
    await cleanupSession({ sdk, sessionID: source.id })
    await cleanupSession({ sdk, sessionID: target.id })
  }
})
