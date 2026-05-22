import { expect, type Page } from "@playwright/test"
import { openSidebar, withSession } from "../actions"
import { test } from "../fixtures"
import { bodyText } from "../prompt/mock"
import { applyDarkModeForTests } from "../utils"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

function patch(file: string, marker: string) {
  return [
    "*** Begin Patch",
    `*** Add File: ${file}`,
    `+title ${marker}`,
    `+line one`,
    `+line two`,
    `+line three`,
    "*** End Patch",
  ].join("\n")
}

async function seedTurn(
  llm: Parameters<typeof test>[0]["llm"],
  sdk: Parameters<typeof test>[0]["project"]["sdk"],
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
        if (!aggregate || aggregate.kind === "empty" || aggregate.kind === "uncaptured") return 0
        return aggregate.files.filter((file) => file.restoreState === "applied").length
      },
      { timeout: 120_000 },
    )
    .toBeGreaterThan(0)
}

async function captureShell(page: Page, label: "light" | "dark"): Promise<Shot> {
  await openSidebar(page)
  await page.locator('[data-component="session-turn-changes"]').first().waitFor({ state: "visible", timeout: 30_000 })
  return { name: label, buf: await page.screenshot({ fullPage: false }) }
}

// Whole-shell composition: sidebar + center chat + right pane (turn changes)
// in one frame. Lighter snap targets crop to a single component; this one
// catches cross-surface harmony — e.g. a sidebar that goes off-canvas while
// the center pane keeps the old token, or a divider that goes invisible at
// the chrome/body seam.
test("app-shell", async ({ page, project, llm }) => {
  test.setTimeout(360_000)

  // Locale stays at the default (English) so the openSidebar action's
  // aria-label regex (`/toggle sidebar/i`) still matches; this snap is
  // about the dark/light surface stack, not localized copy.
  await project.open()

  const shots: Shot[] = []

  await withSession(project.sdk, "snap app shell light", async (session) => {
    project.trackSession(session.id)
    await seedTurn(llm, project.sdk, session.id, patch("snap-shell-light.txt", "shell-light"))
    await project.gotoSession(session.id)
    shots.push(await captureShell(page, "light"))
  })

  await applyDarkModeForTests(page)

  await withSession(project.sdk, "snap app shell dark", async (session) => {
    project.trackSession(session.id)
    await seedTurn(llm, project.sdk, session.id, patch("snap-shell-dark.txt", "shell-dark"))
    await project.gotoSession(session.id)
    shots.push(await captureShell(page, "dark"))
  })

  const out = snapOutputPath("app-shell")
  await composeGrid(shots, out)
  process.stdout.write(`\n[snap] app-shell grid -> ${out}\n\n`)
})
