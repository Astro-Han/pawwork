import { test } from "../fixtures"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

// Seed a user message that carries a structured skill part alongside prose, the
// shape buildRequestParts produces for an inline skill chip. The bubble must
// render the skill as a chip (glyph + bare name in brand accent) inside the
// prose, NOT suppress the body the way the leading commandInvocation does.
// noReply keeps the snap fast and independent of a fake-LLM round-trip.
async function seedSkillMessage(
  sdk: ReturnType<typeof import("../utils").createSdk>,
  directory: string,
  sessionTitle: string,
  text: string,
  name: string,
): Promise<string> {
  const session = await sdk.session.create({ directory, title: sessionTitle })
  const sessionID = session.data?.id
  if (!sessionID) throw new Error(`session.create returned no id for "${sessionTitle}"`)

  const token = `/${name}`
  const start = text.indexOf(token)
  if (start < 0) throw new Error(`"${token}" not found in seed text for "${sessionTitle}"`)
  const end = start + token.length

  await sdk.session.prompt({
    sessionID,
    directory,
    noReply: true,
    parts: [
      { type: "text", text },
      { type: "skill", name, source: { value: token, start, end } },
    ],
  })

  return sessionID
}

async function captureBubble(page: import("@playwright/test").Page, name: string): Promise<Shot> {
  const bubble = page.locator('[data-component="user-message"]').last()
  await bubble.waitFor({ state: "visible", timeout: 30_000 })
  await page.locator('[data-highlight="skill"]').last().waitFor({ state: "visible", timeout: 30_000 })
  return { name, buf: await bubble.screenshot() }
}

test("message-skill-inline", async ({ page, project }) => {
  test.setTimeout(180_000)

  await project.open()

  const scenarios = [
    { name: "leading", text: "/summarize the open threads before standup", skill: "summarize" },
    { name: "mid-sentence", text: "Please /summarize this thread for me", skill: "summarize" },
    {
      name: "with-prose",
      text: "Take the design notes above and /summarize them into three bullets I can paste into the release notes",
      skill: "summarize",
    },
  ]

  const shots: Shot[] = []

  for (const sc of scenarios) {
    const sessionID = await seedSkillMessage(project.sdk, project.directory, `snap ${sc.name}`, sc.text, sc.skill)
    await project.gotoSession(sessionID)
    shots.push(await captureBubble(page, sc.name))
  }

  const out = snapOutputPath("message-skill-inline")
  await composeGrid(shots, out)
  process.stdout.write(`\n[snap] message-skill-inline grid -> ${out}\n\n`)
})
