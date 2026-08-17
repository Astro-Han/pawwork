import { test, expect } from "../fixtures"
import { withSession } from "../actions"
import { sessionMessageItemSelector } from "../selectors"

test("@smoke keeps newly sent messages at the end of a session after message IDs wrap", async ({
  page,
  project,
  assistant,
}) => {
  test.setTimeout(120_000)

  await project.open()
  await withSession(project.sdk, `e2e message rollover ${Date.now()}`, async (session) => {
    project.trackSession(session.id)
    const olderID = "msg_fd0000000000old"
    await project.sdk.session.promptAsync({
      sessionID: session.id,
      messageID: olderID,
      noReply: true,
      parts: [{ type: "text", text: "message before rollover" }],
    })
    await project.gotoSession(session.id)
    await expect(page.locator(`[data-message-id="${olderID}"]`)).toBeVisible()

    const userToken = `rollover_user_${Date.now()}`
    const assistantToken = `rollover_assistant_${Date.now()}`
    await assistant.reply(assistantToken)
    expect(await project.prompt(userToken)).toBe(session.id)

    let userID = ""
    let assistantID = ""
    await expect
      .poll(
        async () => {
          const messages = await project.sdk.session
            .messages({ sessionID: session.id, limit: 100 })
            .then((response) => response.data ?? [])
          const user = messages.find(
            (message) =>
              message.info.role === "user" &&
              message.parts.some((part) => part.type === "text" && part.text.includes(userToken)),
          )
          const reply = user
            ? messages.find(
                (message) =>
                  message.info.role === "assistant" &&
                  message.info.parentID === user.info.id &&
                  message.parts.some((part) => part.type === "text" && part.text.includes(assistantToken)),
              )
            : undefined
          userID = user?.info.id ?? ""
          assistantID = reply?.info.id ?? ""
          return !!userID && !!assistantID
        },
        { timeout: 30_000 },
      )
      .toBe(true)
    expect(userID < olderID).toBe(true)

    const renderedIDs = async () =>
      page.locator(sessionMessageItemSelector).evaluateAll((messages) =>
        messages.map((message) => message.getAttribute("data-message-id")).filter((id): id is string => !!id),
      )

    const latestTurn = page.locator(`[data-message-id="${userID}"]`)
    await expect(latestTurn).toBeVisible()
    await expect(latestTurn).toContainText(assistantToken)
    await expect.poll(renderedIDs).toEqual([olderID, userID])

    await page.reload({ waitUntil: "domcontentloaded" })
    await expect.poll(renderedIDs).toEqual([olderID, userID])
    await expect(page.locator(`[data-message-id="${userID}"]`)).toContainText(assistantToken)
    expect(page.url()).toContain(`/session/${session.id}`)
  })
})
