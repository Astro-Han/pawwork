import { test, expect } from "../fixtures"
import { cleanupSession, clearSessionDockSeed, seedSessionQuestion } from "../actions"
import { questionDockSelector } from "../selectors"
import { inputMatch } from "../prompt/mock"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 1280, height: 520 }, deviceScaleFactor: 2 })

type Sdk = Parameters<typeof clearSessionDockSeed>[0]

async function withSession<T>(
  sdk: Sdk,
  title: string,
  fn: (session: { id: string; title: string }) => Promise<T>,
  trackSession?: (sessionID: string) => void,
) {
  const session = await sdk.session.create({ title }).then((r) => r.data)
  if (!session?.id) throw new Error("Session create did not return an id")
  trackSession?.(session.id)
  try {
    return await fn(session)
  } finally {
    await clearSessionDockSeed(sdk, session.id).catch(() => undefined)
    await cleanupSession({ sdk, sessionID: session.id })
  }
}

async function captureDock(page: import("@playwright/test").Page, name: string): Promise<Shot> {
  await page.addStyleTag({ content: '[data-component="toast-region"] { display: none !important; }' })
  const dock = page.locator(questionDockSelector)
  await expect(dock).toBeVisible({ timeout: 30_000 })
  return { name, buf: await dock.screenshot() }
}

test("question-dock-long-description", async ({ page, project, llm }) => {
  test.setTimeout(180_000)

  const questions = [
    {
      header: "Need input",
      question: "Pick the deployment approach for this change.",
      custom: false,
      options: [
        {
          label: "Small PR",
          description: `Keep the change focused on the broken description validation. ${"This explanation is intentionally long enough to show that the option description can scroll inside its own area without making the whole dock too tall. ".repeat(5)}`,
        },
        { label: "Full sync", description: "Also revisit other question fields and product copy." },
        { label: "Defer", description: "Do not change schema behavior in this PR." },
      ],
    },
  ]

  await project.open()
  const shot = await withSession(
    project.sdk,
    "snap question dock long description",
    async (session) => {
      await project.gotoSession(session.id)
      await llm.toolMatch(inputMatch({ questions }), "question", { questions })
      await seedSessionQuestion(project.sdk, { sessionID: session.id, questions })
      return captureDock(page, "long-description")
    },
    project.trackSession,
  )

  const out = snapOutputPath("question-dock-long-description")
  await composeGrid([shot], out)
  process.stdout.write(`\n[snap] question-dock-long-description grid -> ${out}\n\n`)
})
