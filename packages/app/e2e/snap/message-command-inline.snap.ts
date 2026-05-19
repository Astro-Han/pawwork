import { test } from "../fixtures"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

const TEMPLATE_BODY = [
  "# Brainstorming methodology",
  "",
  "If this template body ever appears in the bubble, the inline-mark",
  "suppression has failed. The bubble must show only `/brainstorming <args>`",
  "as an inline mark, not these paragraphs.",
].join("\n")

// Snap covers the frontend render path. Backend metadata stamping
// (executeCommand → templateParts → commandInvocation) is verified by the
// opencode unit tests; here we inject the metadata directly via SDK so the
// snap test stays fast and does not depend on a fake-LLM round-trip.
async function seedCommandMessage(
  sdk: ReturnType<typeof import("../utils").createSdk>,
  directory: string,
  sessionTitle: string,
  args: string,
): Promise<string> {
  const session = await sdk.session.create({ directory, title: sessionTitle })
  const sessionID = session.data?.id
  if (!sessionID) throw new Error(`session.create returned no id for "${sessionTitle}"`)

  const trimmedArgs = args.trim()
  const displayArgs = trimmedArgs.length > 80 ? trimmedArgs.slice(0, 79) + "…" : trimmedArgs
  const invocation: Record<string, unknown> = {
    name: "brainstorming",
    source: "command",
    icon: "command",
  }
  if (trimmedArgs.length > 0) invocation.args = trimmedArgs
  if (displayArgs.length > 0) invocation.displayArgs = displayArgs

  await sdk.session.prompt({
    sessionID,
    directory,
    noReply: true,
    parts: [
      {
        type: "text",
        text: TEMPLATE_BODY,
        metadata: { commandInvocation: invocation, commandTemplate: true },
      },
    ],
  })

  return sessionID
}

async function captureBubble(page: import("@playwright/test").Page, name: string): Promise<Shot> {
  const bubble = page.locator('[data-component="user-message"]').last()
  await bubble.waitFor({ state: "visible", timeout: 30_000 })
  await page.locator(".user-message-command-mark").last().waitFor({ state: "visible", timeout: 30_000 })
  return { name, buf: await bubble.screenshot() }
}

test("message-command-inline", async ({ page, project }) => {
  test.setTimeout(180_000)

  await project.open()

  const scenarios = [
    { name: "no-args", args: "" },
    { name: "with-args", args: "fold the slash command into an inline mark" },
    {
      name: "long-args",
      args: "x".repeat(120) +
        " plus more text to verify the inline mark wraps gracefully when args overflow the bubble width across multiple lines",
    },
  ]

  const shots: Shot[] = []

  for (const sc of scenarios) {
    const sessionID = await seedCommandMessage(project.sdk, project.directory, `snap ${sc.name}`, sc.args)
    await project.gotoSession(sessionID)
    shots.push(await captureBubble(page, sc.name))

    // Suppression invariant — the template body must not leak into the DOM.
    const dom = await page.content()
    if (dom.includes("If this template body ever appears in the bubble")) {
      throw new Error(`template leaked into the DOM for scenario "${sc.name}"`)
    }
  }

  const out = snapOutputPath("message-command-inline")
  await composeGrid(shots, out)
  process.stdout.write(`\n[snap] message-command-inline grid -> ${out}\n\n`)
})
