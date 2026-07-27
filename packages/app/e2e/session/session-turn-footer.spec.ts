import { test, expect } from "../fixtures"
import { sessionIDFromUrl, withSession } from "../actions"
import { bodyText } from "../prompt/mock"
import { promptSelector } from "../selectors"

test("assistant footer is hover-only and copy writes response to clipboard", async ({
  page,
  context,
  project,
  llm,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"])
  await project.open()

  const reply = "Hello from assistant body for footer test."
  await llm.text(reply)
  await project.prompt("seed footer hover")

  const container = page.locator('[data-slot="session-turn-message-container"]').last()
  const footer = container.locator('[data-slot="assistant-turn-footer"]')
  await expect(footer).toBeAttached({ timeout: 30_000 })

  const opacityBeforeHover = await footer.evaluate((el) => getComputedStyle(el).opacity)
  expect(Number(opacityBeforeHover)).toBe(0)

  await container.hover()
  await expect.poll(async () => footer.evaluate((el) => getComputedStyle(el).opacity), { timeout: 5_000 }).toBe("1")

  const copy = footer.getByRole("button").first()
  await copy.click()
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  expect(clip).toBe(reply)
})

test("assistant footer forks through the selected turn into a new session", async ({ page, project, llm }) => {
  await project.open()

  const firstPrompt = "seed the fork source turn"
  const firstReply = "First reply kept in the fork."
  const secondPrompt = "seed a later turn excluded from the fork"
  const secondReply = "Later reply excluded from the fork."

  await llm.text(firstReply)
  const sourceSessionID = await project.prompt(firstPrompt)
  await llm.text(secondReply)
  expect(await project.prompt(secondPrompt)).toBe(sourceSessionID)

  const firstTurn = page.locator('[data-slot="session-turn-message-container"]').filter({ hasText: firstReply })
  await firstTurn.hover()
  await firstTurn.getByRole("button", { name: "Fork to new session" }).click()

  await expect.poll(() => sessionIDFromUrl(page.url()) ?? "").not.toBe(sourceSessionID)
  const forkedSessionID = sessionIDFromUrl(page.url())
  if (!forkedSessionID) throw new Error("Expected the forked session route")
  project.trackSession(forkedSessionID)

  await expect(page.getByText(firstPrompt, { exact: true })).toBeVisible()
  await expect(page.getByText(firstReply, { exact: true })).toBeVisible()
  await expect(page.getByText(secondPrompt, { exact: true })).toHaveCount(0)
  await expect(page.getByText(secondReply, { exact: true })).toHaveCount(0)
  await expect(page.locator(promptSelector).first()).toHaveText("")

  const sourceMessages = await project.sdk.session
    .messages({ sessionID: sourceSessionID, limit: 100 })
    .then((result) => result.data ?? [])
  expect(sourceMessages.some((message) => message.parts.some((part) => part.type === "text" && part.text === secondReply))).toBe(
    true,
  )
})

test("assistant footer renders below the turn changes panel in the same turn", async ({ page, project, llm }) => {
  test.setTimeout(180_000)
  await project.open()

  const patchText = [
    "*** Begin Patch",
    "*** Add File: footer-order-fixture.txt",
    "+seeded",
    "*** End Patch",
  ].join("\n")
  const marker = "seed apply_patch then reply for footer ordering"

  await withSession(project.sdk, "footer order with panel", async (session) => {
    project.trackSession(session.id)
    await llm.toolMatch((hit) => bodyText(hit).includes(marker), "apply_patch", { patchText })
    await llm.text("Done patching.")
    await project.sdk.session.prompt({
      sessionID: session.id,
      agent: "build",
      system: [
        "You are seeding deterministic e2e UI state.",
        "Call apply_patch once with the provided JSON input, then send a short text reply.",
        `Use this JSON input for apply_patch: ${JSON.stringify({ patchText })}`,
      ].join("\n"),
      parts: [{ type: "text", text: marker }],
    })

    await expect
      .poll(
        async () => {
          const aggregate = await project.sdk.session.diff({ sessionID: session.id }).then((res) => res.data)
          if (!aggregate || aggregate.kind === "empty" || aggregate.kind === "uncaptured") return 0
          return aggregate.files.filter((file) => file.restoreState === "applied").length
        },
        { timeout: 120_000 },
      )
      .toBeGreaterThan(0)

    await project.gotoSession(session.id)

    const panel = page.locator('[data-component="session-turn-changes"]').first()
    const footer = page.locator('[data-slot="assistant-turn-footer"]').first()
    await expect(panel).toBeVisible({ timeout: 60_000 })
    await expect(footer).toBeAttached({ timeout: 60_000 })

    const panelBox = await panel.boundingBox()
    const footerBox = await footer.boundingBox()
    if (!panelBox || !footerBox) throw new Error("Failed to measure panel/footer position")
    expect(footerBox.y).toBeGreaterThanOrEqual(panelBox.y + panelBox.height)
  })
})
