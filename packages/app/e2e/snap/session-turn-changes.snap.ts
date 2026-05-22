import { expect, type Page } from "@playwright/test"
import { withSession } from "../actions"
import { test } from "../fixtures"
import { bodyText } from "../prompt/mock"
import { applyDarkModeForTests } from "../utils"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

const LANGUAGE_KEY = "pawwork.global.dat:language"

function patch(file: string, marker: string) {
  return [
    "*** Begin Patch",
    `*** Add File: ${file}`,
    `+title ${marker}`,
    `+mark ${marker}`,
    "+line three",
    "*** End Patch",
  ].join("\n")
}

function aggregateFiles(
  aggregate: Awaited<ReturnType<Parameters<typeof withSession>[0]["session"]["diff"]>>["data"] | undefined,
) {
  if (!aggregate || aggregate.kind === "empty" || aggregate.kind === "uncaptured") return []
  return aggregate.files.filter((file) => file.restoreState === "applied")
}

async function patchWithMock(
  llm: Parameters<typeof test>[0]["llm"],
  sdk: Parameters<typeof withSession>[0],
  sessionID: string,
  patchText: string,
) {
  const callsBefore = await llm.calls()
  await llm.toolMatch(
    (hit) => bodyText(hit).includes("Your only valid response is one apply_patch tool call."),
    "apply_patch",
    { patchText },
  )
  await sdk.session.prompt({
    sessionID,
    agent: "build",
    system: [
      "You are seeding deterministic snap UI state.",
      "Your only valid response is one apply_patch tool call.",
      `Use this JSON input: ${JSON.stringify({ patchText })}`,
      "Do not call any other tools.",
      "Do not output plain text.",
    ].join("\n"),
    parts: [{ type: "text", text: "Apply the provided patch exactly once." }],
  })

  await expect.poll(() => llm.calls().then((c) => c > callsBefore), { timeout: 30_000 }).toBe(true)
  await expect
    .poll(
      async () => {
        const aggregate = await sdk.session.diff({ sessionID }).then((res) => res.data)
        return aggregateFiles(aggregate).length
      },
      { timeout: 120_000 },
    )
    .toBeGreaterThan(0)
}

async function uncapturedWithMock(
  llm: Parameters<typeof test>[0]["llm"],
  sdk: Parameters<typeof withSession>[0],
  sessionID: string,
  file: string,
) {
  const command = `touch ${file}`
  const callsBefore = await llm.calls()
  await llm.toolMatch((hit) => bodyText(hit).includes("Your only valid response is one bash tool call."), "bash", {
    command,
    description: "Writes an uncaptured snap fixture",
  })
  await sdk.session.prompt({
    sessionID,
    agent: "build",
    system: [
      "You are seeding deterministic snap UI state.",
      "Your only valid response is one bash tool call.",
      `Use this JSON input: ${JSON.stringify({ command, description: "Writes an uncaptured snap fixture" })}`,
      "Do not call any other tools.",
      "Do not output plain text.",
    ].join("\n"),
    parts: [{ type: "text", text: "Run the provided shell command exactly once." }],
  })

  await expect.poll(() => llm.calls().then((c) => c > callsBefore), { timeout: 30_000 }).toBe(true)
  await expect
    .poll(
      async () => {
        const aggregate = await sdk.session.diff({ sessionID }).then((res) => res.data)
        return aggregate?.kind === "uncaptured" || aggregate?.kind === "mixed"
      },
      { timeout: 120_000 },
    )
    .toBe(true)
}

async function captureTurnChanges(page: Page, name: string): Promise<Shot> {
  const panel = page.locator('[data-component="session-turn-changes"]').first()
  await panel.waitFor({ state: "visible", timeout: 30_000 })
  return { name, buf: await panel.screenshot() }
}

async function runCapturedPass(
  page: Page,
  project: Parameters<typeof test>[0]["project"],
  llm: Parameters<typeof test>[0]["llm"],
  label: "light" | "dark",
  shots: Shot[],
) {
  await withSession(project.sdk, `snap turn changes captured ${label}`, async (session) => {
    project.trackSession(session.id)
    await patchWithMock(llm, project.sdk, session.id, patch(`snap-captured-${label}.txt`, `captured-${label}`))
    await project.gotoSession(session.id)
    shots.push(await captureTurnChanges(page, `${label}-captured-applied`))

    const action = page.locator('[data-slot="session-turn-changes-action"]').first()
    await expect(action).toBeVisible()
    await action.click()
    await action.click()
    await expect(page.locator('[data-slot="session-turn-changes-undone"]').first()).toBeVisible()
    shots.push(await captureTurnChanges(page, `${label}-captured-undone`))
  })

  await withSession(project.sdk, `snap turn changes uncaptured ${label}`, async (session) => {
    project.trackSession(session.id)
    await uncapturedWithMock(llm, project.sdk, session.id, `snap-uncaptured-${label}.txt`)
    await project.gotoSession(session.id)
    shots.push(await captureTurnChanges(page, `${label}-uncaptured`))
  })
}

test("session-turn-changes", async ({ page, project, llm }) => {
  test.setTimeout(360_000)

  await page.addInitScript((key) => {
    localStorage.setItem(key, JSON.stringify({ locale: "zh" }))
  }, LANGUAGE_KEY)

  await project.open()
  const shots: Shot[] = []

  await runCapturedPass(page, project, llm, "light", shots)

  // Flip to dark via the real storage + reload path, then re-do the same
  // setup with fresh sessions. applyDarkModeForTests is one-way per page,
  // so the dark pass runs after all light shots are captured.
  await applyDarkModeForTests(page)
  await runCapturedPass(page, project, llm, "dark", shots)

  const out = snapOutputPath("session-turn-changes")
  await composeGrid(shots, out)
  process.stdout.write(`\n[snap] session-turn-changes grid -> ${out}\n\n`)
})
