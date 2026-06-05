import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test, expect } from "../fixtures"
import { openSidebar } from "../actions"
import { promptSelector } from "../selectors"

// Seed a project-scoped skill so the gallery has a deterministic capability to
// open and activate in a clean env, independent of any ambient global skills.
async function seedProjectSkill(directory: string, name: string, description: string) {
  const skillDir = join(directory, ".agents", "skills", name)
  await mkdir(skillDir, { recursive: true })
  await writeFile(
    join(skillDir, "SKILL.md"),
    ["---", `name: ${name}`, `description: ${description}`, "---", "", "Summarize the thread into three bullets."].join("\n"),
  )
}

test("Skills sidebar entry opens the gallery; Escape closes detail then surface", async ({ page, project }) => {
  await project.open({
    setup: async (directory) => {
      await seedProjectSkill(directory, "summarize", "Summarize the conversation")
    },
  })
  await openSidebar(page)

  await page.locator('[data-action="pawwork-skills-open"]').click()
  const surface = page.locator('[data-component="skills-page"]')
  await expect(surface).toBeVisible()

  const row = surface.locator('[data-action="skill-open"][data-skill="summarize"]')
  await expect(row).toBeVisible({ timeout: 30_000 })
  await row.click()

  const detail = page.locator('[data-component="skill-detail"]')
  await expect(detail).toBeVisible()

  // Escape returns to the gallery first, then closes the surface.
  await page.keyboard.press("Escape")
  await expect(detail).toHaveCount(0)
  await expect(surface).toBeVisible()

  // The surface's Escape defers to the dialog stack, which clears `active`
  // ~100ms after the detail unmounts (exit grace in useDialog). Wait it out — as
  // a real user does, watching the modal vanish — before the second Escape.
  await page.waitForTimeout(200)
  await page.keyboard.press("Escape")
  await expect(surface).toHaveCount(0)
})

test("Escape over the gallery closes a sidebar-opened palette first, then the surface", async ({ page, project }) => {
  await project.open({
    setup: async (directory) => {
      await seedProjectSkill(directory, "summarize", "Summarize the conversation")
    },
  })
  await openSidebar(page)

  await page.locator('[data-action="pawwork-skills-open"]').click()
  const surface = page.locator('[data-component="skills-page"]')
  await expect(surface).toBeVisible()

  // The sidebar stays live behind the gallery; its search opens the command
  // palette via command.show(), which bypasses the keybind gate that otherwise
  // suppresses palettes behind a surface. The gallery's Escape handler must
  // defer to that palette (a dialog-stack modal) before closing itself.
  await page.locator('[data-action="pawwork-session-search"]').click()
  const palette = page.getByRole("dialog")
  await expect(palette).toBeVisible()

  await page.keyboard.press("Escape")
  await expect(palette).toHaveCount(0)
  await expect(surface).toBeVisible()

  await page.waitForTimeout(200)
  await page.keyboard.press("Escape")
  await expect(surface).toHaveCount(0)
})

test("a deep link carrying both ?skill= and ?prompt= seeds only the skill chip", async ({ page, project }) => {
  await project.open({
    setup: async (directory) => {
      await seedProjectSkill(directory, "summarize", "Summarize the conversation")
    },
  })

  // Skill wins on a combined link: the chip seeds and the stray prompt text must
  // not survive (the skill bootstrap clears both params so prompt can't re-seed).
  await page.goto(`/${project.slug}/session?skill=summarize&prompt=hello`)

  await expect(page.locator(promptSelector)).toBeVisible()
  const chip = page.locator('[data-type="skill"][data-name="summarize"]')
  await expect(chip).toBeVisible({ timeout: 30_000 })
  await expect(chip.locator("[data-cmd-label]")).toHaveText("summarize")
  await expect(page.locator(promptSelector)).not.toContainText("hello")
})

test("Use in chat opens a new session and inserts the skill chip", async ({ page, project }) => {
  await project.open({
    setup: async (directory) => {
      await seedProjectSkill(directory, "summarize", "Summarize the conversation")
    },
  })
  await openSidebar(page)

  await page.locator('[data-action="pawwork-skills-open"]').click()
  const surface = page.locator('[data-component="skills-page"]')
  await expect(surface).toBeVisible()

  await surface.locator('[data-action="skill-open"][data-skill="summarize"]').click()
  await expect(page.locator('[data-component="skill-detail"]')).toBeVisible()

  await page.locator('[data-action="skill-use-in-chat"]').click()

  // The surface closes and a fresh session composer seeds the structured skill
  // chip, exactly as typing /summarize would, with no leading slash on the label.
  await expect(surface).toHaveCount(0)
  await expect(page.locator(promptSelector)).toBeVisible()
  const chip = page.locator('[data-type="skill"][data-name="summarize"]')
  await expect(chip).toBeVisible({ timeout: 30_000 })
  await expect(chip.locator("[data-cmd-label]")).toHaveText("summarize")
})
