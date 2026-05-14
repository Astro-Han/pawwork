import { test, expect } from "../fixtures"
import { openRightPanel } from "../actions"
import { bodyText } from "../prompt/mock"

test("added files stay quiet until the user opens the Files tab", async ({ page, llm, project }) => {
  const callsBefore = await llm.calls()
  await project.open()
  const session = await project.sdk.session.create({ title: "E2E artifacts" }).then((res) => {
    if (!res.data?.id) throw new Error("Failed to create e2e session")
    return res.data
  })
  project.trackSession(session.id)
  await project.gotoSession(session.id)

  await llm.toolMatch(
    (hit) => bodyText(hit).includes("Your only valid response is one apply_patch tool call."),
    "apply_patch",
    {
      patchText: ["*** Begin Patch", "*** Add File: artifact-report.md", "+# Report", "+hello", "*** End Patch"].join(
        "\n",
      ),
    },
  )

  await project.sdk.session.prompt({
    sessionID: session.id,
    agent: "build",
    system: [
      "You are seeding deterministic e2e UI state.",
      "Your only valid response is one apply_patch tool call.",
      `Use this JSON input: ${JSON.stringify({ patchText: ["*** Begin Patch", "*** Add File: artifact-report.md", "+# Report", "+hello", "*** End Patch"].join("\n") })}`,
      "Do not call any other tools.",
      "Do not output plain text.",
    ].join("\n"),
    parts: [{ type: "text", text: "Apply the provided patch exactly once." }],
  })

  await expect.poll(() => llm.calls().then((count) => count > callsBefore), { timeout: 30000 }).toBe(true)
  const rightPanel = page.locator('[data-component="right-panel"]')
  await expect(rightPanel).toHaveAttribute("aria-hidden", "true")

  const panel = await openRightPanel(page)
  await panel.getByRole("button", { name: "Add tab" }).click()
  await page.getByRole("menuitem", { name: "Files" }).click()

  const shellTabList = panel.getByRole("tablist").first()
  const filesTab = shellTabList.getByRole("tab", { name: "Files", exact: true })
  await expect(filesTab).toHaveAttribute("aria-selected", "true")
  await expect(page.locator('[data-artifact-file="artifact-report.md"]')).toBeVisible({ timeout: 30000 })
  await expect(page.getByRole("button", { name: /open file/i })).toBeVisible()
  await expect(page.getByRole("button", { name: /open folder/i })).toBeVisible()
})
