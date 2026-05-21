import type { Page } from "@playwright/test"
import { test } from "../fixtures"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 1100, height: 400 }, deviceScaleFactor: 2 })

const SEED_REPLY = "Acknowledged. Seeded turn ready for compaction."
const SUMMARY_TEXT = [
  "## Goal",
  "- Validate the compaction divider rendering",
  "",
  "## Progress",
  "### Done",
  "- Seeded one user turn",
].join("\n")

async function seedTurn(
  sdk: ReturnType<typeof import("../utils").createSdk>,
  directory: string,
  sessionID: string,
  prompt: string,
) {
  await sdk.session.prompt({
    sessionID,
    directory,
    parts: [{ type: "text", text: prompt }],
  })
}

async function captureDivider(page: Page, name: string): Promise<Shot> {
  const divider = page.locator('[data-slot="session-turn-compaction"]').last()
  await divider.waitFor({ state: "visible", timeout: 30_000 })
  return { name, buf: await divider.screenshot() }
}

async function waitForState(page: Page, state: string, timeoutMs: number) {
  await page.waitForFunction(
    (expected) => {
      const part = document.querySelector(
        '[data-slot="session-turn-compaction"] [data-component="compaction-part"]',
      )
      const current = part?.getAttribute("data-state")
      return current === expected
    },
    state,
    { timeout: timeoutMs },
  )
}

// Real production snap for the compaction divider across all four states.
// Each state runs in its own session so the divider's data-state attribute
// transitions are isolated from siblings.
test("compaction-divider", async ({ page, project, assistant }) => {
  test.setTimeout(360_000)

  await project.open()
  const { directory } = project
  const projectSdk = project.sdk

  const shots: Shot[] = []

  // ── DONE ───────────────────────────────────────────────────────────────────
  await assistant.reply(SEED_REPLY)
  const doneSession = await projectSdk.session.create({ directory, title: "snap compaction-done" })
  const doneSessionID = doneSession.data?.id
  if (!doneSessionID) throw new Error("session.create returned no id (done)")
  await seedTurn(projectSdk, directory, doneSessionID, "Seed for done")
  await project.gotoSession(doneSessionID)
  await assistant.reply(SUMMARY_TEXT)
  await projectSdk.session.summarize({
    sessionID: doneSessionID,
    providerID: "opencode",
    modelID: "big-pickle",
  })
  await waitForState(page, "done", 45_000)
  shots.push(await captureDivider(page, "done"))

  // ── FAILED ─────────────────────────────────────────────────────────────────
  // HTTP 400 from the LLM endpoint. The OpenAI client wraps it as APIError
  // with isRetryable=false; retry.ts L63 returns undefined immediately, so
  // the schedule yields Cause.done(0) and Effect.catch(halt) writes the
  // error onto the placeholder summary assistant. Divider reads `failed`.
  await assistant.reply(SEED_REPLY)
  const failedSession = await projectSdk.session.create({ directory, title: "snap compaction-failed" })
  const failedSessionID = failedSession.data?.id
  if (!failedSessionID) throw new Error("session.create returned no id (failed)")
  await seedTurn(projectSdk, directory, failedSessionID, "Seed for failed")
  await project.gotoSession(failedSessionID)
  await assistant.error(400, { error: { type: "BadRequest", message: "Compaction model rejected the request" } })
  try {
    await projectSdk.session.summarize({
      sessionID: failedSessionID,
      providerID: "opencode",
      modelID: "big-pickle",
    })
  } catch {
    // expected — summarize surfaces the same error to the API client too
  }
  await waitForState(page, "failed", 45_000)
  shots.push(await captureDivider(page, "failed"))

  // ── PENDING + ABORTED ──────────────────────────────────────────────────────
  // hang() returns Stream.never so the compaction streams forever; the
  // placeholder summary assistant stays in pending. After capturing pending
  // we call session.abort which trips Effect.onInterrupt in compaction.ts,
  // writing MessageAbortedError onto the placeholder.
  await assistant.reply(SEED_REPLY)
  const pendingSession = await projectSdk.session.create({ directory, title: "snap compaction-pending" })
  const pendingSessionID = pendingSession.data?.id
  if (!pendingSessionID) throw new Error("session.create returned no id (pending)")
  await seedTurn(projectSdk, directory, pendingSessionID, "Seed for pending")
  await project.gotoSession(pendingSessionID)
  await assistant.hang()
  // Fire-and-forget: summarize returns once the request is accepted, the
  // actual compaction call hangs on the LLM stream.
  void projectSdk.session.summarize({
    sessionID: pendingSessionID,
    providerID: "opencode",
    modelID: "big-pickle",
  })
  await waitForState(page, "pending", 45_000)
  shots.push(await captureDivider(page, "pending"))

  await projectSdk.session.abort({ sessionID: pendingSessionID, directory })
  await waitForState(page, "aborted", 45_000)
  shots.push(await captureDivider(page, "aborted"))

  const out = snapOutputPath("compaction-divider")
  await composeGrid(shots, out, { cols: 2 })
  process.stdout.write(`\n[snap] compaction-divider grid -> ${out}\n\n`)
})
