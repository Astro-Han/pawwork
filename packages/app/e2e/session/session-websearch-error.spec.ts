import { test, expect } from "../fixtures"

const LANGUAGE_KEY = "pawwork.global.dat:language"

test("websearch Exa failures render localized recovery copy", async ({ page, project, assistant }, testInfo) => {
  await page.addInitScript((key) => {
    localStorage.setItem(key, JSON.stringify({ locale: "zh" }))
  }, LANGUAGE_KEY)

  await project.open()
  await assistant.reply("seed response")
  const sessionID = await project.prompt("Show a websearch error card.")
  const messages = await project.sdk.session.messages({ sessionID, limit: 50 }).then((res) => res.data ?? [])
  const assistantMessage = messages.find((message) => message.info.role === "assistant")
  const textPart = assistantMessage?.parts.find((part) => part.type === "text")
  if (!assistantMessage || !textPart) throw new Error("Expected assistant text part to replace with websearch error")

  const now = Date.now()
  const websearchPart = {
    id: textPart.id,
    sessionID,
    messageID: assistantMessage.info.id,
    type: "tool" as const,
    callID: `call_websearch_error_${now}`,
    tool: "websearch",
    state: {
      status: "error" as const,
      input: { query: "PawWork websearch quota" },
      error: "Tool execution aborted",
      metadata: {
        webSearch: {
          failure: {
            kind: "quota_exceeded",
            source: "anonymous",
            status: 429,
          },
        },
      },
      time: {
        start: now - 10,
        end: now,
      },
    },
  }

  await project.sdk.part.update({
    sessionID,
    messageID: assistantMessage.info.id,
    partID: textPart.id,
    part: websearchPart,
  })

  await project.gotoSession(sessionID)

  const card = page.locator('[data-kind="tool-error-card"]').filter({ hasText: "网络搜索" }).first()
  await expect(card).toBeVisible()
  await expect(card).toContainText("搜索额度已用完")
  await expect(card).not.toContainText("Tool execution aborted")

  await card.click()
  await expect(card).toHaveAttribute("data-open", "true")
  await expect(card).toContainText("内置网络搜索额度已用完。你可以在设置里添加 Exa API Key，或配置 EXA_API_KEY 后再试。")
  await expect(card).not.toContainText("Tool execution aborted")

  const screenshotPath = testInfo.outputPath("websearch-error-card-zh.png")
  await card.screenshot({ path: screenshotPath })
  await testInfo.attach("websearch-error-card-zh", {
    path: screenshotPath,
    contentType: "image/png",
  })
})
