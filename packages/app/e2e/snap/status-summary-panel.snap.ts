import { expect, type Page } from "@playwright/test"
import type { Todo } from "@opencode-ai/sdk/v2/client"
import { test } from "../fixtures"
import { openRightPanel, openSidebar } from "../actions"
import { sessionItemSelector } from "../selectors"
import { bodyText } from "../prompt/mock"
import type { createSdk } from "../utils"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

// Companion to status-summary-todos.snap.ts. That target covers the four todo
// marker variants in isolation; this one drives the whole Overview panel
// (Progress / Workspace / Changed files / Sources) so each section's rest
// state plus the Changed files row's rest→hover trailing transition has a
// durable baseline. Required so future picker / hover-token regressions on
// any of the four sections — not just todos — surface in CI.

type Sdk = ReturnType<typeof createSdk>
type LLM = Parameters<typeof test>[0]["llm"]

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

const SEED_TODOS: Array<Pick<Todo, "content" | "status" | "priority">> = [
  { content: "Wire status summary markers", status: "completed", priority: "high" },
  { content: "Cover all four states in snap", status: "in_progress", priority: "high" },
  { content: "Queue follow-up cleanup", status: "pending", priority: "medium" },
  { content: "Notify user for review", status: "cancelled", priority: "low" },
]

const SEED_SOURCES = [
  "https://docs.pawwork.dev/status-panel",
  "https://blog.pawwork.dev/2026/changelog",
]

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

async function seedTodos(input: { url: string; directory: string; sessionID: string }) {
  const response = await fetch(
    `${input.url}/session/__e2e/update-todos?directory=${encodeURIComponent(input.directory)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: input.sessionID, todos: SEED_TODOS }),
    },
  )
  if (response.status !== 204) {
    throw new Error(`update-todos failed: ${response.status} ${await response.text()}`)
  }
}

async function applyPatchTurn(llm: LLM, sdk: Sdk, sessionID: string, patchText: string) {
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
}

async function seedWebfetchSource(input: {
  llm: LLM
  sdk: Sdk
  sessionID: string
  url: string
  prompt: string
  reply: string
}) {
  const beforeCount = await input.sdk.session.messages({ sessionID: input.sessionID, limit: 200 })
    .then((r) => (r.data ?? []).length)
  await input.llm.text(input.reply)
  await input.sdk.session.prompt({
    sessionID: input.sessionID,
    agent: "build",
    parts: [{ type: "text", text: input.prompt }],
  })

  // Poll until the assistant has finished persisting at least one new message
  // with a text part. We don't match on text content — the build agent may add
  // reasoning/tool parts around the seeded reply, and a content-equality check
  // breaks on whitespace or wrapper drift. Newest-first scan picks the seed
  // turn's text without colliding with prior apply_patch turns (which have
  // no text part).
  let target:
    | Awaited<ReturnType<Sdk["session"]["messages"]>>["data"][number]
    | undefined
  let textPart: Extract<
    Awaited<ReturnType<Sdk["session"]["messages"]>>["data"][number]["parts"][number],
    { type: "text" }
  > | undefined
  await expect
    .poll(
      async () => {
        const messages = await input.sdk.session.messages({ sessionID: input.sessionID, limit: 200 })
          .then((r) => r.data ?? [])
        if (messages.length <= beforeCount) return false
        for (let i = messages.length - 1; i >= beforeCount; i -= 1) {
          const message = messages[i]
          if (message.info.role !== "assistant") continue
          const tp = message.parts.find((p) => p.type === "text")
          if (tp) {
            target = message
            textPart = tp as typeof textPart
            return true
          }
        }
        return false
      },
      { timeout: 60_000 },
    )
    .toBe(true)
  if (!target || !textPart) throw new Error(`Failed to find seeded text part for ${input.url}`)

  const now = Date.now()
  await input.sdk.part.update({
    sessionID: input.sessionID,
    messageID: target.info.id,
    partID: textPart.id,
    part: {
      id: textPart.id,
      sessionID: input.sessionID,
      messageID: target.info.id,
      type: "tool",
      callID: `call_snap_webfetch_${now}`,
      tool: "webfetch",
      state: {
        status: "completed",
        input: { url: input.url, format: "text" },
        output: `Fetched ${input.url}`,
        title: input.url,
        metadata: {},
        time: { start: now - 12, end: now },
      },
    },
  })
}

// Wait for the panel to reflect the exact seeded counts (4 todos, 2 artifacts,
// 2 sources). Exact counts catch partial-seed regressions that a "first row
// visible" wait would miss — e.g. one webfetch part failing to attach would
// leave only one Source row, but a "first visible" check would still pass.
async function waitForAllSections(panel: ReturnType<Page["locator"]>) {
  await expect.poll(() => panel.locator('[data-slot="status-summary-todo"]').count(), { timeout: 30_000 }).toBe(4)
  await expect.poll(() => panel.locator('[data-slot="status-summary-artifact"]').count(), { timeout: 30_000 }).toBe(2)
  await expect.poll(() => panel.locator('[data-slot="status-summary-source"]').count(), { timeout: 30_000 }).toBe(2)
  // The first artifact row must show its per-path diff stats (+N −N) before
  // we screenshot. If the path-key normalization broke, the row would render
  // without numbers, and a rest-state snapshot would silently match a
  // diff-less baseline. Match on text content rather than CSS class so the
  // assertion is robust to the artifact row's exact markup.
  const firstArtifact = panel.locator('[data-slot="status-summary-artifact"]').first()
  await expect(firstArtifact).toContainText(/\+\d+/, { timeout: 10_000 })
  await expect(firstArtifact).toContainText(/−\d+/, { timeout: 10_000 })
}

// The mock LLM backend triggers a "Server unreachable" health-check toast plus
// per-turn "Response ready" toasts, all anchored bottom-right where they cover
// the lower half of the right panel. Hide the notifications region via CSS so
// the snap captures the Sources section, not a notification stack. CSS instead
// of clicking Dismiss because some toasts auto-regenerate while the LLM mock
// is still emitting events.
async function hideToasts(page: Page) {
  await page.addStyleTag({
    content: '[data-component="toast-region"]{display:none !important;}',
  })
}

test("status-summary-panel", async ({ page, project, llm }) => {
  test.setTimeout(240_000)

  let sessionID: string | undefined
  await project.open({
    beforeGoto: async ({ sdk }) => {
      const session = await sdk.session.create({ title: "snap status summary panel" }).then((r) => r.data)
      if (!session?.id) throw new Error("Failed to create session")
      sessionID = session.id
    },
  })
  if (!sessionID) throw new Error("Session create did not return an id")
  project.trackSession(sessionID)

  await seedTodos({ url: project.url, directory: project.directory, sessionID })
  await applyPatchTurn(llm, project.sdk, sessionID, patch("snap-status-panel-a.txt", "alpha"))
  await applyPatchTurn(llm, project.sdk, sessionID, patch("snap-status-panel-b.txt", "beta"))
  await seedWebfetchSource({
    llm,
    sdk: project.sdk,
    sessionID,
    url: SEED_SOURCES[0],
    prompt: "Reference the docs page.",
    reply: "snap docs reference",
  })
  await seedWebfetchSource({
    llm,
    sdk: project.sdk,
    sessionID,
    url: SEED_SOURCES[1],
    prompt: "Reference the changelog.",
    reply: "snap changelog reference",
  })

  // Wait for the turn-change aggregate to capture both patched files before
  // navigating; otherwise the right panel might render mid-aggregation and snap
  // an empty Changed files section.
  await expect
    .poll(
      async () => {
        const aggregate = await project.sdk.session.diff({ sessionID: sessionID! }).then((r) => r.data)
        if (!aggregate || aggregate.kind === "empty" || aggregate.kind === "uncaptured") return 0
        return aggregate.files.filter((file) => file.restoreState === "applied").length
      },
      { timeout: 120_000 },
    )
    .toBeGreaterThanOrEqual(2)

  await openSidebar(page)
  await page.locator(sessionItemSelector(sessionID)).click()
  const panel = await openRightPanel(page)
  await waitForAllSections(panel)
  await hideToasts(page)

  const shots: Shot[] = []

  // Park the cursor away so the artifact-row trailing slot shows diff stats
  // (rest state). animations:"disabled" freezes the in_progress todo's pw-spin
  // ring so consecutive runs render the same frame.
  await page.mouse.move(0, 0)
  shots.push({ name: "panel rest", buf: await panel.screenshot({ animations: "disabled" }) })

  // Hover the first artifact row to capture the trailing rest→hover transition:
  // the +N −N diff fades out, the open + reveal IconButtons fade in. This is
  // the new contract introduced when the panel adopted the turn-change trailing
  // pattern; without this shot a regression to "always show actions" or
  // "actions on top of diff" would slip past CI.
  const artifactRow = panel.locator('[data-slot="status-summary-artifact"]').first()
  await artifactRow.hover()
  await expect(artifactRow.locator('[data-component="icon-button"]').first()).toBeVisible({ timeout: 5_000 })
  // Wait out the opacity transition (~150ms) so the action icons are fully
  // visible and the diff stats fully faded before the screenshot.
  await page.waitForTimeout(220)
  shots.push({ name: "panel artifact hover", buf: await panel.screenshot({ animations: "disabled" }) })

  const out = snapOutputPath("status-summary-panel")
  await composeGrid(shots, out, { cols: 2 })
  process.stdout.write(`\n[snap] status-summary-panel grid -> ${out}\n\n`)
})
