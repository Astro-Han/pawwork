import { test, expect } from "../fixtures"
import { openSettings, withSession } from "../actions"

test("@smoke memory settings exposes the raw MEMORY.md controls", async ({ page, project }) => {
  await project.open()
  await project.sdk.memory.reset()

  const settings = await openSettings(page)
  await settings.getByRole("tab", { name: "Memory" }).click()

  await expect(settings.getByRole("heading", { level: 2, name: "Memory" })).toBeVisible()
  await expect(settings.getByText("Enable memory")).toBeVisible()
  await expect(settings.getByText("Raw MEMORY.md", { exact: true })).toBeVisible()

  const raw = settings.locator('[data-action="settings-memory-raw"]')
  await expect(raw).toBeVisible()
  await expect(raw).toHaveValue(/# PawWork Memory/)
  await expect(raw).toHaveValue(/## Profile/)
  await expect(raw).toHaveValue(/## Archive/)

  const next = [
    "# PawWork Memory",
    "<!-- pawwork-memory-version: 1 -->",
    "",
    "## Profile",
    "- e2e memory settings profile",
    "",
    "## Archive",
    "",
  ].join("\n")

  await raw.fill(next)
  await settings.getByRole("button", { name: "Save" }).click()

  await expect
    .poll(async () => {
      const state = await project.sdk.memory.get().then((response) => response.data as { content?: string })
      return state.content ?? ""
    })
    .toContain("e2e memory settings profile")
})

test("idle session shows memory review and saves redacted entries", async ({ page, project }) => {
  await project.open()
  await project.sdk.memory.reset()

  await withSession(project.sdk, "memory review e2e", async (session) => {
    project.trackSession(session.id)
    await project.gotoSession(session.id)

    const review = page.locator('[data-component="session-memory-review"]')
    await expect(review).toBeVisible()
    await expect(review.getByText("Remember this session?")).toBeVisible()

    await review.locator('[data-action="session-memory-review-text"]').fill("Remember sk-test-secret from this session")
    await review.getByRole("button", { name: "Save memory" }).click()

    await expect(review).toBeHidden()
    await expect
      .poll(async () => {
        const state = await project.sdk.memory.get().then((response) => response.data as { content?: string })
        return state.content ?? ""
      })
      .toContain("[REDACTED]")

    const state = await project.sdk.memory.get().then((response) => response.data as { content?: string })
    expect(state.content ?? "").not.toContain("sk-test-secret")
  })
})
