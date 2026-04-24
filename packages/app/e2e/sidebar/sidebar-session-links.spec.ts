import { test, expect } from "../fixtures"
import { cleanupSession, cleanupTestProject, createTestProject, openSidebar, waitSession } from "../actions"
import { promptSelector } from "../selectors"

test("sidebar session links navigate to the selected session", async ({ page, slug, sdk, gotoSession }) => {
  const stamp = Date.now()

  const one = await sdk.session.create({ title: `e2e sidebar nav 1 ${stamp}` }).then((r) => r.data)
  const two = await sdk.session.create({ title: `e2e sidebar nav 2 ${stamp}` }).then((r) => r.data)

  if (!one?.id) throw new Error("Session create did not return an id")
  if (!two?.id) throw new Error("Session create did not return an id")

  try {
    await gotoSession(one.id)

    await openSidebar(page)

    const target = page.locator(`[data-session-id="${two.id}"] a`).first()
    await expect(target).toBeVisible()
    await target.click()

    await expect(page).toHaveURL(new RegExp(`/${slug}/session/${two.id}(?:\\?|#|$)`))
    await expect(page.locator(promptSelector)).toBeVisible()
    await expect(page.locator(`[data-session-id="${two.id}"] a`).first()).toHaveClass(/\bactive\b/)
  } finally {
    await cleanupSession({ sdk, sessionID: one.id })
    await cleanupSession({ sdk, sessionID: two.id })
  }
})

test("sidebar session links can switch workspaces without opening the error boundary", async ({ page, backend, project }) => {
  const stamp = Date.now()
  const other = await createTestProject({ serverUrl: backend.url })
  const otherSdk = backend.sdk(other)
  let targetID = ""
  let sourceID = ""

  try {
    const target = await otherSdk.session.create({ title: `e2e cross workspace target ${stamp}` }).then((r) => r.data)
    if (!target?.id) throw new Error("Target session create did not return an id")
    targetID = target.id

    await project.open({
      extra: [other],
      beforeGoto: async ({ sdk }) => {
        const source = await sdk.session.create({ title: `e2e cross workspace source ${stamp}` }).then((r) => r.data)
        if (!source?.id) throw new Error("Source session create did not return an id")
        sourceID = source.id
        project.trackSession(source.id)
      },
    })
    project.trackDirectory(other)
    project.trackSession(targetID, other)

    await project.gotoSession(sourceID)
    await openSidebar(page)

    const targetLink = page.locator(`[data-session-id="${targetID}"] a`).first()
    await expect(targetLink).toBeVisible()
    await targetLink.click()

    await waitSession(page, { directory: other, sessionID: targetID, serverUrl: backend.url })
    await expect(page.locator(promptSelector)).toBeVisible()
  } finally {
    if (targetID) await cleanupSession({ sdk: otherSdk, sessionID: targetID })
    await cleanupTestProject(other)
  }
})
