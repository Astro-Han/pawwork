import type { Page, Route } from "@playwright/test"
import { test, expect } from "../fixtures"
import { cleanupSession, cleanupTestProject, createTestProject, openSidebar, waitSession, withSession } from "../actions"
import { promptSelector, sessionComposerDockSelector, sessionTurnListSelector } from "../selectors"
import type { createSdk } from "../utils"

async function sessionRowPaint(page: Page, sessionID: string) {
  return page
    .locator(`[data-session-id="${sessionID}"][data-component="pawwork-session-row"]`)
    .first()
    .evaluate((element) => {
      const statusDefault = element.querySelector("[data-status-default]") as HTMLElement | null
      const statusOverlay = element.querySelector("[data-status-overlay]") as HTMLElement | null
      return {
        backgroundColor: getComputedStyle(element).backgroundColor,
        selectedLayerOpacity: getComputedStyle(element, "::before").opacity,
        hoverLayerOpacity: getComputedStyle(element, "::after").opacity,
        statusDefaultOpacity: statusDefault ? getComputedStyle(statusDefault).opacity : null,
        statusOverlayOpacity: statusOverlay ? getComputedStyle(statusOverlay).opacity : null,
      }
    })
}

async function nextFrame(page: Page) {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
}

async function sessionDragWrapperOpacity(page: Page, sessionID: string) {
  return page
    .locator(`.pw-drag-row[data-pw-drag-session-id="${sessionID}"]`)
    .first()
    .evaluate((element) => getComputedStyle(element).opacity)
}

async function expectUrlToStayMatched(page: Page, pattern: RegExp, stableFor = 300) {
  let stableSince = Date.now()
  await expect
    .poll(() => {
      if (!pattern.test(page.url())) {
        stableSince = Date.now()
        return false
      }
      return Date.now() - stableSince >= stableFor
    })
    .toBe(true)
}

async function seedUserMessage(input: {
  sdk: ReturnType<typeof createSdk>
  sessionID: string
  text: string
}) {
  await input.sdk.session.promptAsync({
    sessionID: input.sessionID,
    noReply: true,
    parts: [{ type: "text", text: input.text }],
  })

  await expect
    .poll(
      async () => {
        const messages = await input.sdk.session.messages({ sessionID: input.sessionID, limit: 20 }).then((r) => r.data ?? [])
        return messages.some((message) =>
          message.info.role === "user" &&
          message.parts.some((part) => part.type === "text" && part.text.includes(input.text)),
        )
      },
      { timeout: 30_000 },
    )
    .toBe(true)
}

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

    const selectedSessionUrl = new RegExp(`/${slug}/session/${two.id}(?:\\?|#|$)`)
    await expect(page).toHaveURL(selectedSessionUrl)
    await expectUrlToStayMatched(page, selectedSessionUrl)
    await expect(page.locator(promptSelector)).toBeVisible()
    await expect(page.locator(`[data-session-id="${two.id}"] a`).first()).toHaveClass(/\bactive\b/)

    await page.locator('[data-action="pawwork-session-new"]').click()
    await expect(page).toHaveURL(new RegExp(`/${slug}/session(?:\\?|#|$)`))
    await expect(page.locator('[data-component="session-new-home"]')).toBeVisible()
  } finally {
    await cleanupSession({ sdk, sessionID: one.id })
    await cleanupSession({ sdk, sessionID: two.id })
  }
})

test("sidebar session selection paint switches without leaving the previous row highlighted", async ({ page, slug, sdk, gotoSession }) => {
  const stamp = Date.now()

  const source = await sdk.session.create({ title: `e2e sidebar paint source ${stamp}` }).then((r) => r.data)
  const target = await sdk.session.create({ title: `e2e sidebar paint target ${stamp}` }).then((r) => r.data)

  if (!source?.id) throw new Error("Source session create did not return an id")
  if (!target?.id) throw new Error("Target session create did not return an id")

  try {
    await gotoSession(source.id)
    await openSidebar(page)

    const sourceLink = page.locator(`[data-session-id="${source.id}"] a`).first()
    await expect(sourceLink).toBeVisible()
    await sourceLink.click()
    await expect(page).toHaveURL(new RegExp(`/${slug}/session/${source.id}(?:\\?|#|$)`))

    const targetRow = page.locator(`[data-session-id="${target.id}"][data-component="pawwork-session-row"]`).first()
    await expect(targetRow).toBeVisible()
    const targetBox = await targetRow.boundingBox()
    if (!targetBox) throw new Error("Target session row did not expose a bounding box")

    await page.mouse.move(targetBox.x + targetBox.width / 3, targetBox.y + targetBox.height / 2)
    await nextFrame(page)
    await page.mouse.down()
    await nextFrame(page)
    await page.mouse.up()

    const immediateTargetPaint = await sessionRowPaint(page, target.id)
    expect(immediateTargetPaint.selectedLayerOpacity).toBe("1")
    expect(immediateTargetPaint.hoverLayerOpacity).toBe("0")

    await expect(page).toHaveURL(new RegExp(`/${slug}/session/${target.id}(?:\\?|#|$)`))

    await expect(page.locator(`[data-session-id="${target.id}"] a`).first()).toHaveClass(/\bactive\b/)
    const sourcePaint = await sessionRowPaint(page, source.id)
    const targetPaint = await sessionRowPaint(page, target.id)

    expect(sourcePaint.backgroundColor).toBe("rgba(0, 0, 0, 0)")
    expect(sourcePaint.selectedLayerOpacity).toBe("0")
    expect(sourcePaint.statusDefaultOpacity).toBe("1")
    expect(sourcePaint.statusOverlayOpacity).toBe("0")
    expect(targetPaint.selectedLayerOpacity).toBe("1")
    expect(targetPaint.hoverLayerOpacity).toBe("0")
    expect(targetPaint.statusDefaultOpacity).toBe("0")
    expect(targetPaint.statusOverlayOpacity).toBe("1")
  } finally {
    await cleanupSession({ sdk, sessionID: source.id })
    await cleanupSession({ sdk, sessionID: target.id })
  }
})

test("sidebar switch paint suppresses hover before the active class arrives", async ({ page, sdk, gotoSession }) => {
  const stamp = Date.now()

  const source = await sdk.session.create({ title: `e2e sidebar switch source ${stamp}` }).then((r) => r.data)
  const target = await sdk.session.create({ title: `e2e sidebar switch target ${stamp}` }).then((r) => r.data)

  if (!source?.id) throw new Error("Source session create did not return an id")
  if (!target?.id) throw new Error("Target session create did not return an id")

  try {
    await gotoSession(source.id)
    await openSidebar(page)

    const targetRow = page.locator(`[data-session-id="${target.id}"][data-component="pawwork-session-row"]`).first()
    await expect(targetRow).toBeVisible()
    await targetRow.hover()
    await targetRow.evaluate((element) => element.setAttribute("data-switch-paint", "target"))

    const targetPaint = await sessionRowPaint(page, target.id)
    expect(targetPaint.selectedLayerOpacity).toBe("1")
    expect(targetPaint.hoverLayerOpacity).toBe("0")
  } finally {
    await cleanupSession({ sdk, sessionID: source.id })
    await cleanupSession({ sdk, sessionID: target.id })
  }
})

test("sidebar session press does not dim the row before drag starts", async ({ page, sdk, gotoSession }) => {
  const stamp = Date.now()
  const source = await sdk.session.create({ title: `e2e sidebar press source ${stamp}` }).then((r) => r.data)
  const target = await sdk.session.create({ title: `e2e sidebar press target ${stamp}` }).then((r) => r.data)

  if (!source?.id) throw new Error("Source session create did not return an id")
  if (!target?.id) throw new Error("Target session create did not return an id")

  try {
    await gotoSession(source.id)
    await openSidebar(page)

    const targetRow = page.locator(`[data-session-id="${target.id}"][data-component="pawwork-session-row"]`).first()
    await expect(targetRow).toBeVisible()
    const targetBox = await targetRow.boundingBox()
    if (!targetBox) throw new Error("Target session row did not expose a bounding box")

    await page.mouse.move(targetBox.x + targetBox.width / 3, targetBox.y + targetBox.height / 2)
    await nextFrame(page)
    await page.mouse.down()
    try {
      await expect.poll(() => sessionDragWrapperOpacity(page, target.id)).toBe("1")
    } finally {
      await page.mouse.up()
    }
  } finally {
    await cleanupSession({ sdk, sessionID: source.id })
    await cleanupSession({ sdk, sessionID: target.id })
  }
})

test("sidebar session click with slight jitter still navigates instead of starting a drag", async ({ page, slug, sdk, gotoSession }) => {
  const stamp = Date.now()
  const source = await sdk.session.create({ title: `e2e sidebar jitter source ${stamp}` }).then((r) => r.data)
  const target = await sdk.session.create({ title: `e2e sidebar jitter target ${stamp}` }).then((r) => r.data)

  if (!source?.id) throw new Error("Source session create did not return an id")
  if (!target?.id) throw new Error("Target session create did not return an id")

  try {
    await gotoSession(source.id)
    await openSidebar(page)

    const targetRow = page.locator(`[data-session-id="${target.id}"][data-component="pawwork-session-row"]`).first()
    await expect(targetRow).toBeVisible()
    const targetBox = await targetRow.boundingBox()
    if (!targetBox) throw new Error("Target session row did not expose a bounding box")

    // Press, drift a few px (inside the 5px fallbackTolerance dead zone), release.
    // This is the hand-jitter case a 0-tolerance config misread as a drag, which
    // swallowed the click so navigation never fired and the row felt unresponsive.
    const startX = targetBox.x + targetBox.width / 3
    const startY = targetBox.y + targetBox.height / 2
    await page.mouse.move(startX, startY)
    await nextFrame(page)
    await page.mouse.down()
    await page.mouse.move(startX + 3, startY + 3, { steps: 3 })
    await nextFrame(page)
    await page.mouse.up()

    const selectedSessionUrl = new RegExp(`/${slug}/session/${target.id}(?:\\?|#|$)`)
    await expect(page).toHaveURL(selectedSessionUrl)
    await expect(page.locator(`[data-session-id="${target.id}"] a`).first()).toHaveClass(/\bactive\b/)
    // The row did not get dragged anywhere: still exactly one instance in the sidebar.
    await expect(page.locator(`[data-session-id="${target.id}"][data-component="pawwork-session-row"]`)).toHaveCount(1)
  } finally {
    await cleanupSession({ sdk, sessionID: source.id })
    await cleanupSession({ sdk, sessionID: target.id })
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

test("opening a delayed sidebar session never shows the previous session as loading UI", async ({ page, slug, sdk, gotoSession }) => {
  const stamp = Date.now()
  const sourceText = `e2e stale source ${stamp}`
  const targetText = `e2e delayed target ${stamp}`

  await withSession(sdk, `e2e stale source title ${stamp}`, async (source) => {
    await withSession(sdk, `e2e delayed target title ${stamp}`, async (target) => {
      await seedUserMessage({ sdk, sessionID: source.id, text: sourceText })
      await seedUserMessage({ sdk, sessionID: target.id, text: targetText })

      let releaseMessages: (() => void) | undefined
      const messagesReleased = new Promise<void>((resolve) => {
        releaseMessages = resolve
      })
      let targetMessageRequests = 0
      const delayTargetMessages = async (route: Route) => {
        targetMessageRequests++
        await messagesReleased
        await route.continue().catch(() => undefined)
      }

      await page.route(`**/session/${target.id}/message*`, delayTargetMessages)

      try {
        await gotoSession(source.id)
        await expect(page.locator(sessionTurnListSelector).getByText(sourceText)).toBeVisible()
        const sourceDockBox = await page.locator(sessionComposerDockSelector).boundingBox()
        if (!sourceDockBox) throw new Error("Source composer dock did not expose a bounding box")
        await openSidebar(page)
        await expect.poll(() => targetMessageRequests, { timeout: 10_000 }).toBeGreaterThan(0)

        await page.locator(`[data-session-id="${target.id}"] a`).first().click()

        await expect(page).toHaveURL(new RegExp(`/${slug}/session/${target.id}(?:\\?|#|$)`))
        await expect(page.locator('[data-component="session-opening-state"]')).toBeVisible()
        await expect(page.locator(sessionTurnListSelector).getByText(sourceText)).toHaveCount(0)
        await expect(page.locator(sessionTurnListSelector).getByText(targetText)).toHaveCount(0)
        await expect(page.locator(promptSelector)).toHaveCount(0)
        const openingDock = page.locator(
          `${sessionComposerDockSelector}[data-state="opening-placeholder"]`,
        )
        await expect(openingDock).toHaveCount(1)
        await expect
          .poll(async () => {
            const openingDockBox = await openingDock.boundingBox()
            return openingDockBox ? Math.abs(openingDockBox.height - sourceDockBox.height) : Infinity
          })
          .toBeLessThanOrEqual(2)

        releaseMessages?.()
        releaseMessages = undefined
        await expect(page.locator(sessionTurnListSelector).getByText(targetText)).toBeVisible()
        await expect(page.locator(promptSelector)).toHaveCount(1)
        await expect(openingDock).toHaveCount(0)
      } finally {
        releaseMessages?.()
        await page.unroute(`**/session/${target.id}/message*`, delayTargetMessages)
      }
    })
  })
})
